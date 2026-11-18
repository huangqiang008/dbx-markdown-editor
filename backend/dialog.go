package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// sanitizeName 过滤注入对话框默认文件名的危险字符与保留字符，保留中英文等合法字符。
// 过滤 Windows 保留字符: \ / : * ? " < > | 以及 PowerShell / 命令敏感字符 ` $ ' ; ( ) { } [ ] & !
var nameSanitizer = regexp.MustCompile(`[\x00-\x1f\\/:*?"<>|\x60$';()\[\]{}&!]`)

func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "未命名.md"
	}
	s = strings.ReplaceAll(s, " ", "_")
	s = nameSanitizer.ReplaceAllString(s, "_")
	if s == "" {
		return "未命名.md"
	}
	return s
}

// 文件类型过滤器
var dialogFilters = map[string]string{
	"markdown": "Markdown (*.md;*.markdown;*.txt)|*.md;*.markdown;*.txt|All files (*.*)|*.*",
	"html":     "HTML 文档 (*.html;*.htm)|*.html;*.htm|All files (*.*)|*.*",
	"pdf":      "PDF 文档 (*.pdf)|*.pdf|All files (*.*)|*.*",
	"docx":     "Word 文档 (*.docx)|*.docx|All files (*.*)|*.*",
	"image":    "PNG 图片 (*.png)|*.png|All files (*.*)|*.*",
	"any":      "All files (*.*)|*.*",
}

// 保存对话框各过滤器对应的默认扩展名（DefaultExt）；缺省按 Markdown 处理
var saveDefaultExts = map[string]string{
	"markdown": "md",
	"html":     "html",
	"pdf":      "pdf",
	"docx":     "docx",
	"image":    "png",
}

// saveDialogDefaults 计算保存对话框的默认文件名、过滤器与默认扩展名（脚本方案与原生方案共用）
func saveDialogDefaults(name, filter string) (n, f, ext string) {
	n = sanitizeName(name)
	var ok bool
	f, ok = dialogFilters[filter]
	if !ok {
		f = dialogFilters["markdown"]
	}
	var known bool
	ext, known = saveDefaultExts[filter]
	if !known {
		ext = "md"
	}
	// 前端传来的默认名已带正确扩展名；缺扩展名时按过滤器补上
	if !strings.Contains(n, ".") {
		n += "." + ext
	} else if filter == "html" && !strings.HasSuffix(strings.ToLower(n), ".htm") && !strings.HasSuffix(strings.ToLower(n), ".html") {
		n = strings.TrimSuffix(n, filepath.Ext(n)) + ".html"
	}
	return n, f, ext
}

// buildDialogScript 生成 PowerShell 对话框脚本（纯函数，便于测试）。
// kind: open | save | dir
func buildDialogScript(kind, name, filter string) (string, error) {
	encoding := `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
# 文件对话框（comdlg32 / shell）的界面语言跟线程 UI 语言走，不认 .NET 的 CurrentUICulture；
# 宿主拉起的 PowerShell 可能回退到英文资源，这里显式把线程语言钉到 zh-CN（0x0804），
# 失败（如系统没装中文语言资源）就自然回退，不影响对话框本身。
try {
  Add-Type -Namespace Native -Name Mui -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadUILanguage(uint lang); [DllImport("kernel32.dll")] public static extern bool SetThreadLocale(uint locale);' -ErrorAction Stop
  [Native.Mui]::SetThreadUILanguage(0x0804) | Out-Null
  [Native.Mui]::SetThreadLocale(0x0804) | Out-Null
} catch {}
[Threading.Thread]::CurrentThread.CurrentUICulture = [Globalization.CultureInfo]::GetCultureInfo("zh-CN")
`
	switch kind {
	case "open":
		f, ok := dialogFilters[filter]
		if !ok {
			f = dialogFilters["markdown"]
		}
		return encoding + `Add-Type -AssemblyName System.Windows.Forms
$ofd = New-Object System.Windows.Forms.OpenFileDialog
$ofd.Filter = "` + f + `"
$ofd.Title = "打开文件"
if ($ofd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($ofd.FileName) }`, nil
	case "save":
		n, f, ext := saveDialogDefaults(name, filter)
		return encoding + `Add-Type -AssemblyName System.Windows.Forms
$sfd = New-Object System.Windows.Forms.SaveFileDialog
$sfd.Filter = "` + f + `"
$sfd.Title = "保存文件"
$sfd.FileName = "` + n + `"
$sfd.DefaultExt = "` + ext + `"
$sfd.AddExtension = $true
if ($sfd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($sfd.FileName) }`, nil
	case "dir":
		return encoding + `Add-Type -AssemblyName System.Windows.Forms
$fbd = New-Object System.Windows.Forms.FolderBrowserDialog
$fbd.Description = "选择要浏览 Markdown 文件的文件夹"
if ($fbd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($fbd.SelectedPath) }`, nil
	default:
		return "", errors.New("unknown dialog kind: " + kind)
	}
}

// runDialog 执行对话框；取消返回 ("", nil)，失败返回 error。
// 优先走 Win32 原生调用（毫秒级唤起），PowerShell 方案只作兜底。
func runDialog(kind, name, filter string) (string, error) {
	if runtime.GOOS != "windows" {
		return "", errors.New("native dialogs are only available on Windows")
	}
	var path string
	var err error
	switch kind {
	case "save":
		path, err = nativeSaveDialog(name, filter)
	case "open":
		path, err = nativeOpenDialog(filter)
	case "dir":
		path, err = nativeDirDialog()
	default:
		return "", errors.New("unknown dialog kind: " + kind)
	}
	if err == nil {
		return path, nil
	}
	return runDialogPS(kind, name, filter)
}

// runDialogPS 旧方案：每次冷启动 PowerShell 加载 WinForms，慢（1.5~3 秒）但实现最简单，留作兜底。
func runDialogPS(kind, name, filter string) (string, error) {
	if runtime.GOOS != "windows" {
		return "", errors.New("native dialogs are only available on Windows")
	}
	script, err := buildDialogScript(kind, name, filter)
	if err != nil {
		return "", err
	}
	// DBX 宿主可能给 sidecar 精简了 PATH，导致按名找不到 powershell.exe；
	// 找不到时退到 SystemRoot 绝对路径。仍失败则由前端降级到内置选择器。
	ps := "powershell.exe"
	if _, lookErr := exec.LookPath(ps); lookErr != nil {
		abs := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		if _, statErr := os.Stat(abs); statErr == nil {
			ps = abs
		}
	}
	cmd := exec.Command(ps, "-NoProfile", "-STA", "-Command", script)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New("dialog failed: " + msg)
	}
	path := strings.TrimSpace(stdout.String())
	if path == "" {
		return "", nil // 用户取消
	}
	return path, nil
}

type pickParams struct {
	Name        string `json:"name"`
	DefaultName string `json:"defaultName"` // 历史键名别名：前端曾用 defaultName，收进来免得名字悄悄变空
	Filter      string `json:"filter"`
}

// pickName 取有效的文件名参数
func (p pickParams) pickName() string {
	if p.Name != "" {
		return p.Name
	}
	return p.DefaultName
}

func handlePickFile(params json.RawMessage) (interface{}, *RPCError) {
	var p pickParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	path, err := runDialog("open", "", p.Filter)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: err.Error()}
	}
	if path == "" {
		return map[string]interface{}{"cancelled": true}, nil
	}
	return map[string]interface{}{"cancelled": false, "path": path}, nil
}

func handlePickSaveFile(params json.RawMessage) (interface{}, *RPCError) {
	var p pickParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	path, err := runDialog("save", p.pickName(), p.Filter)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: err.Error()}
	}
	if path == "" {
		return map[string]interface{}{"cancelled": true}, nil
	}
	return map[string]interface{}{"cancelled": false, "path": path}, nil
}

func handlePickDir(params json.RawMessage) (interface{}, *RPCError) {
	path, err := runDialog("dir", "", "")
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: err.Error()}
	}
	if path == "" {
		return map[string]interface{}{"cancelled": true}, nil
	}
	return map[string]interface{}{"cancelled": false, "path": path}, nil
}
