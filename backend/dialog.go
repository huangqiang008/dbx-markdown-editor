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

// sanitizeName 过滤注入对话框默认文件名的危险字符。
var nameSanitizer = regexp.MustCompile(`[^A-Za-z0-9._\-]`)

func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "untitled.md"
	}
	return nameSanitizer.ReplaceAllString(s, "_")
}

// 文件类型过滤器
var dialogFilters = map[string]string{
	"markdown": "Markdown (*.md;*.markdown;*.txt)|*.md;*.markdown;*.txt|All files (*.*)|*.*",
	"html":     "HTML (*.html;*.htm)|*.html;*.htm|All files (*.*)|*.*",
	"image":    "Images (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg;*.bmp)|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg;*.bmp|All files (*.*)|*.*",
	"any":      "All files (*.*)|*.*",
}

// buildDialogScript 生成 PowerShell 对话框脚本（纯函数，便于测试）。
// kind: open | save | dir
func buildDialogScript(kind, name, filter string) (string, error) {
	encoding := `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
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
		n := sanitizeName(name)
		ext := "md"
		if filter == "html" {
			ext = "html"
			if !strings.HasSuffix(strings.ToLower(n), ".html") {
				n += ".html"
			}
		} else if !strings.Contains(n, ".") {
			n += ".md"
		}
		f, ok := dialogFilters[filter]
		if !ok {
			f = "Markdown (*.md)|*.md|All files (*.*)|*.*"
		}
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

// runDialog 执行对话框脚本；取消返回 ("", nil)，失败返回 error。
func runDialog(kind, name, filter string) (string, error) {
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
	Name   string `json:"name"`
	Filter string `json:"filter"`
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
	path, err := runDialog("save", p.Name, p.Filter)
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
