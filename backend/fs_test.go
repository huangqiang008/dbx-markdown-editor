package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustCall(t *testing.T, method string, params interface{}) map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	res, rpcErr := dispatch(Request{Method: method, Params: raw})
	if rpcErr != nil {
		t.Fatalf("%s: rpc error: %s", method, rpcErr.Message)
	}
	// 走一遍 JSON，模拟前端实际收到的 wire 格式
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return m
}

func callErr(t *testing.T, method string, params interface{}) string {
	t.Helper()
	raw, _ := json.Marshal(params)
	_, rpcErr := dispatch(Request{Method: method, Params: raw})
	if rpcErr == nil {
		t.Fatalf("%s: expected error, got success", method)
	}
	return rpcErr.Message
}

func TestInitialize(t *testing.T) {
	m := mustCall(t, "plugin/initialize", nil)
	plugin := m["plugin"].(map[string]interface{})
	if plugin["id"] != pluginID || plugin["version"] != pluginVersion {
		t.Fatalf("initialize identity mismatch: %v", plugin)
	}
	if m["protocolVersion"].(float64) != 1 {
		t.Fatalf("protocolVersion != 1")
	}
}

func TestReadWriteRoundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	content := "# 标题\n\n正文 **加粗** 与 `代码`\n"

	w := mustCall(t, "fs/write", map[string]string{"path": path, "content": content})
	if w["size"].(float64) != float64(len(content)) {
		t.Fatalf("size mismatch: %v", w["size"])
	}
	r := mustCall(t, "fs/read", map[string]string{"path": path})
	if r["content"] != content {
		t.Fatalf("roundtrip content mismatch")
	}
	// 原子写不应残留临时文件
	items, _ := os.ReadDir(dir)
	if len(items) != 1 {
		t.Fatalf("temp file left behind: %v", items)
	}
	// 覆盖写
	mustCall(t, "fs/write", map[string]string{"path": path, "content": "v2"})
	r2 := mustCall(t, "fs/read", map[string]string{"path": path})
	if r2["content"] != "v2" {
		t.Fatalf("overwrite failed")
	}
}

func TestReadMissingFile(t *testing.T) {
	dir := t.TempDir()
	msg := callErr(t, "fs/read", map[string]string{"path": filepath.Join(dir, "nope.md")})
	if !strings.Contains(msg, "不存在") {
		t.Fatalf("unexpected error: %s", msg)
	}
}

func TestStat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.md")
	mustCall(t, "fs/write", map[string]string{"path": path, "content": "x"})
	st := mustCall(t, "fs/stat", map[string]string{"path": path})
	if st["exists"] != true {
		t.Fatalf("exists != true")
	}
	st2 := mustCall(t, "fs/stat", map[string]string{"path": filepath.Join(dir, "missing.md")})
	if st2["exists"] != false {
		t.Fatalf("missing file should not exist")
	}
}

func TestListTree(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sub", ".git"), 0o755)
	os.MkdirAll(filepath.Join(dir, "node_modules"), 0o755)
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, "root.md"), "content": "a"})
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, "sub", "b.md"), "content": "b"})
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, "sub", "c.txt"), "content": "c"})
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, ".hidden.md"), "content": "h"})
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, "node_modules", "d.md"), "content": "d"})

	m := mustCall(t, "fs/list", map[string]string{"dir": dir})
	entries := m["entries"].([]interface{})
	var names []string
	subDirIndex := -1
	for _, e := range entries {
		entry := e.(map[string]interface{})
		if entry["path"] == dir {
			t.Fatalf("root directory should not be repeated in tree: %v", entry)
		}
		if entry["path"] == filepath.Join(dir, "sub") {
			subDirIndex = len(names)
		}
		names = append(names, entry["name"].(string))
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "root.md") || !strings.Contains(joined, "b.md") {
		t.Fatalf("expected files missing: %v", names)
	}
	if strings.Contains(joined, ".hidden.md") {
		t.Fatalf("hidden file should be skipped: %v", names)
	}
	if strings.Contains(joined, "d.md") || strings.Contains(joined, "node_modules") {
		t.Fatalf("node_modules should be skipped: %v", names)
	}
	if subDirIndex < 0 || subDirIndex+1 >= len(entries) ||
		entries[subDirIndex+1].(map[string]interface{})["path"] != filepath.Join(dir, "sub", "b.md") {
		t.Fatalf("directory children should immediately follow their parent: %v", entries)
	}
	var paths []string
	for _, e := range entries {
		paths = append(paths, e.(map[string]interface{})["path"].(string))
	}
	wantPaths := []string{
		filepath.Join(dir, "root.md"),
		filepath.Join(dir, "sub"),
		filepath.Join(dir, "sub", "b.md"),
		filepath.Join(dir, "sub", "c.txt"),
	}
	if strings.Join(paths, "|") != strings.Join(wantPaths, "|") {
		t.Fatalf("tree entries should retain depth-first order: %v", paths)
	}
}

func TestListBadDir(t *testing.T) {
	msg := callErr(t, "fs/list", map[string]string{"dir": "Z:\\ surely\\ not\\ exist\\ 12345"})
	if msg == "" {
		t.Fatalf("expected error")
	}
}

func TestBrowse(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "zeta"), 0o755)
	os.MkdirAll(filepath.Join(dir, "alpha"), 0o755)
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, "b.md"), "content": "b"})
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, "a.md"), "content": "a"})
	mustCall(t, "fs/write", map[string]string{"path": filepath.Join(dir, "notes.pdf"), "content": "x"})

	m := mustCall(t, "fs/browse", map[string]string{"dir": dir})
	if m["drives"] == true {
		t.Fatalf("drives should be false for a real dir")
	}
	if m["path"] == "" {
		t.Fatalf("path should be echoed")
	}
	entries := m["entries"].([]interface{})
	var names []string
	for _, e := range entries {
		names = append(names, e.(map[string]interface{})["name"].(string))
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "alpha") || !strings.Contains(joined, "a.md") {
		t.Fatalf("expected entries missing: %v", names)
	}
	if strings.Contains(joined, "notes.pdf") {
		t.Fatalf("non-markdown file should be filtered: %v", names)
	}
	// 目录在前 + 目录间按名称排序
	var order []string
	for _, e := range entries {
		em := e.(map[string]interface{})
		if em["isDir"] == true {
			order = append(order, "d:"+em["name"].(string))
		} else {
			order = append(order, "f:"+em["name"].(string))
		}
	}
	if len(order) != 4 || order[0] != "d:alpha" || order[1] != "d:zeta" || order[2] != "f:a.md" || order[3] != "f:b.md" {
		t.Fatalf("unexpected order: %v", order)
	}
}

func TestBrowseDrives(t *testing.T) {
	m := mustCall(t, "fs/browse", map[string]string{"dir": ""})
	if m["drives"] != true {
		t.Fatalf("drives should be true for empty dir")
	}
	entries := m["entries"].([]interface{})
	if len(entries) == 0 {
		t.Fatalf("expected at least one drive")
	}
	for _, e := range entries {
		em := e.(map[string]interface{})
		if em["isDir"] != true {
			t.Fatalf("drive entries should be dirs")
		}
		if !strings.HasSuffix(em["path"].(string), ":\\") {
			t.Fatalf("drive path should end with :\\, got %v", em["path"])
		}
	}
}

func TestBrowseBadDir(t *testing.T) {
	msg := callErr(t, "fs/browse", map[string]string{"dir": "Z:\\ surely\\ not\\ exist\\ 12345"})
	if msg == "" {
		t.Fatalf("expected error")
	}
}

func TestPathValidation(t *testing.T) {
	if _, err := validatePath("   "); err == nil {
		t.Fatalf("empty path should fail")
	}
	if _, err := validatePath("a\x00b"); err == nil {
		t.Fatalf("NUL path should fail")
	}
	abs, err := validatePath("relative\\note.md")
	if err != nil {
		t.Fatalf("relative path should resolve: %v", err)
	}
	if !filepath.IsAbs(abs) {
		t.Fatalf("expected abs path, got %s", abs)
	}
}

func TestReadImage(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "p.png")
	// 1x1 透明 PNG
	data := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x04, 0x00, 0x00, 0x00, 0xB5, 0x1C, 0x0C, 0x02, 0x00, 0x00, 0x00,
		0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0x64, 0xF8, 0x0F, 0x00,
		0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xE3, 0x66, 0x00, 0x00, 0x00, 0x00,
		0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
	}
	if err := os.WriteFile(png, data, 0o644); err != nil {
		t.Fatal(err)
	}
	m := mustCall(t, "fs/readImage", map[string]string{"path": png})
	url, _ := m["dataUrl"].(string)
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("bad dataUrl prefix: %s", url)
	}
	if m["width"] != float64(1) || m["height"] != float64(1) || m["rgbaBase64"] == nil {
		t.Fatalf("missing decoded pixel payload: %#v", m)
	}
	callErr(t, "fs/readImage", map[string]string{"path": filepath.Join(dir, "x.exe")})
}

func TestDialogScripts(t *testing.T) {
	s, err := buildDialogScript("open", "", "markdown")
	if err != nil || !strings.Contains(s, "OpenFileDialog") || !strings.Contains(s, "*.md") {
		t.Fatalf("open script bad: %v", err)
	}
	s, err = buildDialogScript("open", "", "image")
	if err != nil || !strings.Contains(s, "*.png") {
		t.Fatalf("open image script bad: %v", err)
	}
	s, err = buildDialogScript("open", "", "bogus")
	if err != nil || !strings.Contains(s, "*.md") {
		t.Fatalf("unknown filter should fall back to markdown: %v", err)
	}
	s, err = buildDialogScript("save", "my note.md", "md")
	if err != nil || !strings.Contains(s, `"my_note.md"`) {
		t.Fatalf("save script bad: %v %q", err, s)
	}
	s, err = buildDialogScript("save", "", "md")
	if err != nil || !strings.Contains(s, `"untitled.md"`) {
		t.Fatalf("save default name bad: %v", err)
	}
	s, err = buildDialogScript("save", "note", "html")
	if err != nil || !strings.Contains(s, `"note.html"`) || !strings.Contains(s, `DefaultExt = "html"`) || !strings.Contains(s, "HTML (*.html;*.htm)") {
		t.Fatalf("save html script bad: %v %q", err, s)
	}
	// 注入尝试必须被过滤
	s, err = buildDialogScript("save", `a"; rm -rf / #.md`, "md")
	if err != nil || strings.Contains(s, "rm -rf") || strings.Contains(s, `";`) {
		t.Fatalf("injection not sanitized: %q", s)
	}
	s, err = buildDialogScript("dir", "", "")
	if err != nil || !strings.Contains(s, "FolderBrowserDialog") ||
		!strings.Contains(s, `[Threading.Thread]::CurrentThread.CurrentUICulture = [Globalization.CultureInfo]::GetCultureInfo("zh-CN")`) ||
		!strings.Contains(s, `选择要浏览 Markdown 文件的文件夹`) {
		t.Fatalf("dir script bad: %v", err)
	}
	if _, err := buildDialogScript("bogus", "", ""); err == nil {
		t.Fatalf("unknown kind should fail")
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"":                    "untitled.md",
		"note.md":             "note.md",
		"my note.md":          "my_note.md",
		`a";$(calc).md`:       "a____calc_.md",
		"../../../etc/passwd": ".._.._.._etc_passwd",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Fatalf("sanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}
