package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// 这一组 RPC 是给 iml-editor-lite 前端适配层（editor/src/platform/dbxApi.ts）用的：
// 上游界面把文件系统操作抽象成 window.api.fs.*，这里补齐原来 Typedown 版用不到的几个方法。

type extraPathParams struct {
	Path       string `json:"path"`
	NewPath    string `json:"newPath"`
	SourcePath string `json:"sourcePath"`
	TargetPath string `json:"targetPath"`
}

type writeBytesParams struct {
	Path   string `json:"path"`
	Base64 string `json:"base64"`
}

func extraErr(err error) *RPCError {
	return &RPCError{Code: -32000, Message: err.Error()}
}

func decodeExtraParams(params json.RawMessage, out interface{}) *RPCError {
	if err := json.Unmarshal(params, out); err != nil {
		return &RPCError{Code: -32602, Message: "invalid params: " + err.Error()}
	}
	return nil
}

// app/dataDir 返回插件独享的配置目录，设置与会话都存在这里，绕开 host.storage 的 1 MiB 上限。
func handleDataDir(_ json.RawMessage) (interface{}, *RPCError) {
	base, err := os.UserConfigDir()
	if err != nil {
		return nil, extraErr(err)
	}
	dir := filepath.Join(base, pluginID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, extraErr(err)
	}
	return map[string]interface{}{"dir": dir}, nil
}

// fs/readDir 只列单层，供侧边栏文件夹树使用；目录在前、名称排序。
func handleFSReadDir(params json.RawMessage) (interface{}, *RPCError) {
	var p pathParams
	if e := decodeExtraParams(params, &p); e != nil {
		return nil, e
	}
	abs, err := validatePath(p.Path)
	if err != nil {
		return nil, extraErr(err)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, extraErr(err)
	}
	files := make([]map[string]interface{}, 0, len(entries))
	for _, entry := range entries {
		files = append(files, map[string]interface{}{
			"name":        entry.Name(),
			"path":        filepath.Join(abs, entry.Name()),
			"isDirectory": entry.IsDir(),
		})
	}
	sort.SliceStable(files, func(i, j int) bool {
		a, b := files[i], files[j]
		if a["isDirectory"].(bool) != b["isDirectory"].(bool) {
			return a["isDirectory"].(bool)
		}
		return a["name"].(string) < b["name"].(string)
	})
	return map[string]interface{}{"success": true, "files": files, "path": abs}, nil
}

func handleFSMkdir(params json.RawMessage) (interface{}, *RPCError) {
	var p pathParams
	if e := decodeExtraParams(params, &p); e != nil {
		return nil, e
	}
	abs, err := validatePath(p.Path)
	if err != nil {
		return nil, extraErr(err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, extraErr(err)
	}
	return map[string]interface{}{"success": true, "path": abs}, nil
}

func handleFSRename(params json.RawMessage) (interface{}, *RPCError) {
	var p extraPathParams
	if e := decodeExtraParams(params, &p); e != nil {
		return nil, e
	}
	from, err := validatePath(p.Path)
	if err != nil {
		return nil, extraErr(err)
	}
	to, err := validatePath(p.NewPath)
	if err != nil {
		return nil, extraErr(err)
	}
	if err := os.Rename(from, to); err != nil {
		return nil, extraErr(err)
	}
	return map[string]interface{}{"success": true, "oldPath": from, "newPath": to}, nil
}

func handleFSCopy(params json.RawMessage) (interface{}, *RPCError) {
	var p extraPathParams
	if e := decodeExtraParams(params, &p); e != nil {
		return nil, e
	}
	from, err := validatePath(p.SourcePath)
	if err != nil {
		return nil, extraErr(err)
	}
	to, err := validatePath(p.TargetPath)
	if err != nil {
		return nil, extraErr(err)
	}
	b, err := os.ReadFile(from)
	if err != nil {
		return nil, extraErr(err)
	}
	if len(b) > maxFileBytes {
		return nil, extraErr(fmt.Errorf("文件过大（>%d MiB）", maxFileBytes>>20))
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return nil, extraErr(err)
	}
	if err := os.WriteFile(to, b, 0o644); err != nil {
		return nil, extraErr(err)
	}
	return map[string]interface{}{"success": true, "sourcePath": from, "targetPath": to}, nil
}

// fs/delete 只删单个文件/空目录，不递归，避免误删整个文件夹。
func handleFSDelete(params json.RawMessage) (interface{}, *RPCError) {
	var p pathParams
	if e := decodeExtraParams(params, &p); e != nil {
		return nil, e
	}
	abs, err := validatePath(p.Path)
	if err != nil {
		return nil, extraErr(err)
	}
	if err := os.Remove(abs); err != nil {
		return nil, extraErr(err)
	}
	return map[string]interface{}{"success": true, "path": abs, "permanently": true}, nil
}

// fs/writeBytes 接收 base64，用于导出 docx / 长图 PNG 与保存粘贴的图片。
func handleFSWriteBytes(params json.RawMessage) (interface{}, *RPCError) {
	var p writeBytesParams
	if e := decodeExtraParams(params, &p); e != nil {
		return nil, e
	}
	abs, err := validatePath(p.Path)
	if err != nil {
		return nil, extraErr(err)
	}
	b, err := base64.StdEncoding.DecodeString(p.Base64)
	if err != nil {
		return nil, extraErr(fmt.Errorf("base64 解码失败: %v", err))
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, extraErr(err)
	}
	if err := os.WriteFile(abs, b, 0o644); err != nil {
		return nil, extraErr(err)
	}
	return map[string]interface{}{"success": true, "path": abs, "size": len(b)}, nil
}
