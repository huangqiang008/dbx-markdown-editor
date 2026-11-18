//go:build !windows

package main

import (
	"encoding/json"
	"errors"
)

func handleClipboardReadImage(_ json.RawMessage) (interface{}, *RPCError) {
	return map[string]interface{}{"ok": false, "error": errors.New("当前平台不支持读系统剪贴板").Error()}, nil
}
