package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"os"
	"strings"
)

const (
	pluginID      = "com.huangqiang.mdeditor"
	pluginVersion = "1.0.0"
)

// JSON-RPC 2.0 over newline-delimited JSON（stdio-jsonl）
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

func main() {
	// stdout 仅输出协议消息，日志一律 stderr
	log.SetOutput(os.Stderr)

	reader := bufio.NewReader(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err != io.EOF {
				log.Printf("read error: %v", err)
			}
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}
		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			log.Printf("parse error: %v", err)
			continue
		}
		if len(req.ID) == 0 {
			continue
		}
		result, rpcErr := dispatch(req)
		resp := Response{JSONRPC: "2.0", ID: req.ID}
		if rpcErr != nil {
			resp.Error = rpcErr
		} else {
			resp.Result = result
		}
		b, err := json.Marshal(resp)
		if err != nil {
			log.Printf("marshal error: %v", err)
			continue
		}
		writer.Write(b)
		writer.WriteByte('\n')
		writer.Flush()
	}
}

func dispatch(req Request) (interface{}, *RPCError) {
	switch req.Method {
	case "plugin/initialize":
		return handleInitialize(req.Params)
	// 本地文件读写（编辑器核心依赖）
	case "fs/read":
		return handleFSRead(req.Params)
	case "fs/write":
		return handleFSWrite(req.Params)
	case "fs/stat":
		return handleFSStat(req.Params)
	case "fs/list":
		return handleFSList(req.Params)
	case "fs/browse":
		return handleFSBrowse(req.Params)
	case "fs/readImage":
		return handleFSReadImage(req.Params)
	// 原生对话框（Windows PowerShell COM）
	case "fs/pickFile":
		return handlePickFile(req.Params)
	case "fs/pickSaveFile":
		return handlePickSaveFile(req.Params)
	case "fs/pickDir":
		return handlePickDir(req.Params)
	default:
		return nil, &RPCError{Code: -32601, Message: "method not found: " + req.Method}
	}
}

func handleInitialize(params json.RawMessage) (interface{}, *RPCError) {
	return map[string]interface{}{
		"protocolVersion": 1,
		"capabilities":    []string{"events"},
		"plugin": map[string]string{
			"id":      pluginID,
			"version": pluginVersion,
		},
	}, nil
}
