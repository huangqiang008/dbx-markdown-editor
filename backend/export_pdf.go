package main

// PDF 导出：把前端渲染好的静态 HTML 交给系统自带的 Edge/Chrome 无头模式打印成 PDF。
// 沙箱 iframe 里 window.print() 是静默 no-op（没有打印权限），所以必须走这里。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// findChromiumBased 找可用的 Chromium 内核浏览器（Edge 在 Windows 上必装），优先 Edge
func findChromiumBased() string {
	var exes []string
	roots := []string{
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("LocalAppData"),
	}
	rels := []string{
		`Microsoft\Edge\Application\msedge.exe`,
		`Google\Chrome\Application\chrome.exe`,
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		for _, rel := range rels {
			p := filepath.Join(root, rel)
			if _, err := os.Stat(p); err == nil {
				exes = append(exes, p)
			}
		}
	}
	if len(exes) == 0 {
		return ""
	}
	return exes[0]
}

// ensureCharset 保证 HTML 带 UTF-8 声明，避免无头浏览器按本地编码猜
func ensureCharset(html string) string {
	lower := strings.ToLower(html)
	if strings.Contains(lower, "charset") {
		return html
	}
	if i := strings.Index(lower, "<head>"); i >= 0 {
		return html[:i+len("<head>")] + `<meta charset="utf-8">` + html[i+len("<head>"):]
	}
	return `<meta charset="utf-8">` + html
}

func handleExportPDF(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		Target string `json:"target"`
		HTML   string `json:"html"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	if p.Target == "" || p.HTML == "" {
		return nil, &RPCError{Code: -32602, Message: "缺少 target 或 html 参数"}
	}
	exe := findChromiumBased()
	if exe == "" {
		return nil, &RPCError{Code: -32000, Message: "未找到 Edge/Chrome，无法生成 PDF"}
	}

	// 源 HTML 写临时文件（临时目录避免中文路径问题）
	tmp, err := os.CreateTemp("", "md-export-*.html")
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "创建临时文件失败: " + err.Error()}
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(ensureCharset(p.HTML)); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return nil, &RPCError{Code: -32000, Message: "写临时文件失败: " + err.Error()}
	}
	tmp.Close()
	defer os.Remove(tmpName)

	// 独立 user-data-dir：无头实例不与已打开的 Edge 抢配置目录
	profileDir, err := os.MkdirTemp("", "md-export-profile-*")
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "创建临时目录失败: " + err.Error()}
	}
	defer os.RemoveAll(profileDir)

	fileURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(tmpName)}).String()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe,
		"--headless", "--disable-gpu", "--no-first-run", "--disable-extensions",
		"--user-data-dir="+profileDir,
		"--no-pdf-header-footer", "--print-to-pdf-no-header",
		"--print-to-pdf="+p.Target,
		fileURL,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 300 {
			detail = detail[len(detail)-300:]
		}
		if ctx.Err() == context.DeadlineExceeded {
			return nil, &RPCError{Code: -32000, Message: "PDF 生成超时"}
		}
		return nil, &RPCError{Code: -32000, Message: fmt.Sprintf("PDF 生成失败: %v %s", err, detail)}
	}
	if _, err := os.Stat(p.Target); err != nil {
		return nil, &RPCError{Code: -32000, Message: "PDF 未生成，请重试"}
	}
	return map[string]interface{}{"success": true, "path": p.Target}, nil
}
