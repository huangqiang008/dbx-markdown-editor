package main

import (
	"encoding/json"
	"os"
	"testing"
)

// TestVersionSync 防止"manifest 升版本、sidecar 常量忘改"：
// 宿主持久化校验要求 initialize 响应的 id/version 与 manifest 一致，
// 不一致会导致插件初始化失败（ai-proxy 0.2.0 实测踩过）。
func TestVersionSync(t *testing.T) {
	b, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var m struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	if m.ID != pluginID {
		t.Errorf("manifest id %q != pluginID %q", m.ID, pluginID)
	}
	if m.Version != pluginVersion {
		t.Errorf("manifest version %q != pluginVersion %q（改版本号时两处必须同步）", m.Version, pluginVersion)
	}
}
