package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
	"image"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	maxFileBytes     = 16 << 20 // 单文件读取上限 16 MiB
	maxImageBytes    = 2 << 20  // 图片转 dataURL 上限 2 MiB
	maxListFiles     = 5000     // 文件夹遍历文件数上限
	maxListDirs      = 500      // 文件夹遍历目录数上限
	maxBrowseEntries = 2000     // 内置选择器单目录条目上限
)

var mdExts = map[string]bool{".md": true, ".markdown": true, ".txt": true}

var imageExts = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".bmp": "image/bmp", ".ico": "image/x-icon",
}

type pathParams struct {
	Path string `json:"path"`
}

type writeParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type listParams struct {
	Dir string `json:"dir"`
}

// validatePath 做基本卫生检查：非空、无 NUL、转为绝对路径。
// 沙箱前端只能拿到用户本地路径，本 sidecar 以用户权限运行，不做目录禁锢。
func validatePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("empty path")
	}
	if strings.ContainsRune(p, 0) {
		return "", errors.New("invalid path")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("invalid path: %v", err)
	}
	return abs, nil
}

// 毫秒精度：秒级粒度会漏掉同一秒内的保存与外部修改
func fileMtime(info os.FileInfo) int64 {
	return info.ModTime().UnixMilli()
}

func handleFSRead(params json.RawMessage) (interface{}, *RPCError) {
	var p pathParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	path, err := validatePath(p.Path)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: err.Error()}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "文件不存在或不可读: " + path}
	}
	if info.IsDir() {
		return nil, &RPCError{Code: -32000, Message: "路径是目录: " + path}
	}
	if info.Size() > maxFileBytes {
		return nil, &RPCError{Code: -32000, Message: fmt.Sprintf("文件过大（>%d MiB）", maxFileBytes>>20)}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "读取失败: " + err.Error()}
	}
	return map[string]interface{}{
		"content": string(b),
		"size":    info.Size(),
		"mtime":   fileMtime(info),
	}, nil
}

// handleFSWrite 原子写：同目录临时文件 + rename，避免半写文件。
func handleFSWrite(params json.RawMessage) (interface{}, *RPCError) {
	var p writeParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	path, err := validatePath(p.Path)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: err.Error()}
	}
	data := []byte(p.Content)
	if len(data) > maxFileBytes {
		return nil, &RPCError{Code: -32000, Message: fmt.Sprintf("内容过大（>%d MiB）", maxFileBytes>>20)}
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".mdedit-tmp-*")
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "创建临时文件失败: " + err.Error()}
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return nil, &RPCError{Code: -32000, Message: "写入失败: " + err.Error()}
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return nil, &RPCError{Code: -32000, Message: "写入失败: " + err.Error()}
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return nil, &RPCError{Code: -32000, Message: "保存失败: " + err.Error()}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "保存后校验失败: " + err.Error()}
	}
	return map[string]interface{}{
		"mtime": fileMtime(info),
		"size":  info.Size(),
	}, nil
}

func handleFSStat(params json.RawMessage) (interface{}, *RPCError) {
	var p pathParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	path, err := validatePath(p.Path)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: err.Error()}
	}
	info, err := os.Stat(path)
	if err != nil {
		return map[string]interface{}{"exists": false}, nil
	}
	return map[string]interface{}{
		"exists": true,
		"isDir":  info.IsDir(),
		"mtime":  fileMtime(info),
		"size":   info.Size(),
	}, nil
}

type fsEntry struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, ".idea": true, ".vscode": true,
	"dist": true, "build": true, "target": true, "__pycache__": true,
}

// handleFSList 递归列出目录下的 Markdown 文件（带目录节点），供侧栏文件树使用。
func handleFSList(params json.RawMessage) (interface{}, *RPCError) {
	var p listParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	root, err := validatePath(p.Dir)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: err.Error()}
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, &RPCError{Code: -32000, Message: "目录不存在: " + root}
	}
	var entries []fsEntry
	dirCount, fileCount := 0, 0
	truncated := false
	walk := func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 跳过不可访问项
		}
		name := d.Name()
		if path != root && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if path == root {
				return nil
			}
			if skipDirs[name] {
				return filepath.SkipDir
			}
			dirCount++
			if dirCount > maxListDirs {
				truncated = true
				return filepath.SkipAll
			}
			entries = append(entries, fsEntry{Path: path, Name: name, IsDir: true, Mtime: fileMtime(mustStat(d, path))})
			return nil
		}
		if !mdExts[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		fileCount++
		if fileCount > maxListFiles {
			truncated = true
			return filepath.SkipAll
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		entries = append(entries, fsEntry{Path: path, Name: name, Size: fi.Size(), Mtime: fi.ModTime().UnixMilli()})
		return nil
	}
	filepath.WalkDir(root, walk)
	if entries == nil {
		entries = []fsEntry{}
	}
	return map[string]interface{}{
		"root":      root,
		"entries":   entries,
		"truncated": truncated,
	}, nil
}

// handleFSBrowse 列目录的直接子项（目录在前、名称排序），供内置文件/文件夹选择器使用。
// dir 为空时返回可用驱动器列表（drives=true）。只列目录与 Markdown 文件。
func handleFSBrowse(params json.RawMessage) (interface{}, *RPCError) {
	var p listParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	dir := strings.TrimSpace(p.Dir)
	if dir == "" {
		drives := []fsEntry{}
		for _, letter := range "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
			root := string(letter) + ":\\"
			if info, err := os.Stat(root); err == nil && info.IsDir() {
				drives = append(drives, fsEntry{Path: root, Name: root, IsDir: true})
			}
		}
		return map[string]interface{}{"drives": true, "path": "", "entries": drives}, nil
	}
	root, err := validatePath(dir)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: err.Error()}
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, &RPCError{Code: -32000, Message: "目录不存在: " + root}
	}
	des, err := os.ReadDir(root)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "无法读取目录: " + err.Error()}
	}
	entries := []fsEntry{}
	for i, d := range des {
		if i >= maxBrowseEntries {
			break // 单页上限，避免超大目录拖垮前端
		}
		name := d.Name()
		if d.IsDir() {
			if name == "System Volume Information" {
				continue
			}
			entries = append(entries, fsEntry{Path: filepath.Join(root, name), Name: name, IsDir: true})
			continue
		}
		if !mdExts[strings.ToLower(filepath.Ext(name))] {
			continue
		}
		var size int64
		if fi, err := d.Info(); err == nil {
			size = fi.Size()
		}
		entries = append(entries, fsEntry{Path: filepath.Join(root, name), Name: name, Size: size})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.IsDir != b.IsDir {
			return a.IsDir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return map[string]interface{}{"drives": false, "path": root, "entries": entries}, nil
}

func mustStat(d os.DirEntry, path string) os.FileInfo {
	fi, err := d.Info()
	if err != nil {
		return fakeInfo{modTime: time.Now()}
	}
	return fi
}

type fakeInfo struct{ modTime time.Time }

func (f fakeInfo) Name() string       { return "" }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() os.FileMode  { return 0 }
func (f fakeInfo) ModTime() time.Time { return f.modTime }
func (f fakeInfo) IsDir() bool        { return false }
func (f fakeInfo) Sys() any           { return nil }

// handleFSReadImage 把本地图片转成 dataURL，供编辑器内联渲染（含本地相对路径图片）。
func handleFSReadImage(params json.RawMessage) (interface{}, *RPCError) {
	var p pathParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "参数解析失败"}
	}
	path, err := validatePath(p.Path)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: err.Error()}
	}
	ext := strings.ToLower(filepath.Ext(path))
	mime, ok := imageExts[ext]
	if !ok {
		return nil, &RPCError{Code: -32000, Message: "不支持的图片格式: " + ext}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "图片不存在: " + path}
	}
	if info.Size() > maxImageBytes {
		return nil, &RPCError{Code: -32000, Message: fmt.Sprintf("图片过大（>%d MiB）", maxImageBytes>>20)}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "读取图片失败: " + err.Error()}
	}
	result := map[string]interface{}{
		"dataUrl": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b),
		"mime":    mime,
		"size":    info.Size(),
	}
	if ext == ".svg" {
		result["svgText"] = string(b)
		return result, nil
	}
	// DBX 的 UI 沙箱可能禁止 img-src data:/blob:。对 Go 标准库支持的
	// 栅格格式直接返回 RGBA 像素，前端用 canvas.putImageData 绘制。
	if decoded, _, err := image.Decode(bytes.NewReader(b)); err == nil {
		bounds := decoded.Bounds()
		rgba := image.NewRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
		draw.Draw(rgba, rgba.Bounds(), decoded, bounds.Min, draw.Src)
		result["width"] = bounds.Dx()
		result["height"] = bounds.Dy()
		result["rgbaBase64"] = base64.StdEncoding.EncodeToString(rgba.Pix)
	} else {
		result["decodeError"] = err.Error()
	}
	return result, nil
}
