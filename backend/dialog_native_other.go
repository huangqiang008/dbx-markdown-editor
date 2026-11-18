//go:build !windows

package main

import "errors"

// 非 Windows 平台没有原生对话框实现，runDialog 会先检查 GOOS 再走到这里之前就返回错误
func nativeSaveDialog(name, filter string) (string, error) { return "", errors.New("native dialogs are only available on Windows") }
func nativeOpenDialog(filter string) (string, error)       { return "", errors.New("native dialogs are only available on Windows") }
func nativeDirDialog() (string, error)                     { return "", errors.New("native dialogs are only available on Windows") }
