//go:build windows

// 原生 Win32 对话框：直接调 comdlg32 / shell32，毫秒级唤起。
// 之前的 PowerShell + System.Windows.Forms 方案每次要冷启动一个进程再加载程序集，
// 实测 1.5~3 秒，作为原生调用失败时的兜底保留在 dialog.go。
package main

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	comdlg32                 = syscall.NewLazyDLL("comdlg32.dll")
	procGetSaveFileNameW     = comdlg32.NewProc("GetSaveFileNameW")
	procGetOpenFileNameW     = comdlg32.NewProc("GetOpenFileNameW")
	procCommDlgExtendedError = comdlg32.NewProc("CommDlgExtendedError")

	shell32                  = syscall.NewLazyDLL("shell32.dll")
	procSHBrowseForFolderW   = shell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromIDListW = shell32.NewProc("SHGetPathFromIDListW")

	ole32              = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx = ole32.NewProc("CoInitializeEx")
	procCoUninitialize = ole32.NewProc("CoUninitialize")
	procCoTaskMemFree  = ole32.NewProc("CoTaskMemFree")

	user32                  = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")
)

const (
	ofnOverwritePrompt = 0x2
	ofnHideReadOnly    = 0x4
	ofnNoChangeDir     = 0x8
	ofnPathMustExist   = 0x800
	ofnFileMustExist   = 0x1000

	bifReturnOnlyFsDirs = 0x1
	bifNewDialogStyle   = 0x40

	coinitApartmentThreaded = 0x2
)

type openFileNameW struct {
	StructSize    uint32
	Owner         uintptr
	Instance      uintptr
	Filter        *uint16
	CustomFilter  *uint16
	MaxCustFilter uint32
	FilterIndex   uint32
	File          *uint16
	MaxFile       uint32
	FileTitle     *uint16
	MaxFileTitle  uint32
	InitialDir    *uint16
	Title         *uint16
	Flags         uint32
	FileOffset    uint16
	FileExtension uint16
	DefExt        *uint16
	CustData      uintptr
	Hook          uintptr
	TemplateName  *uint16
	Reserved      uintptr
	Reserved2     uint32
	FlagsEx       uint32
}

type browseInfoW struct {
	Owner       uintptr
	Root        uintptr
	DisplayName *uint16
	Title       *uint16
	Flags       uint32
	Callback    uintptr
	Param       uintptr
	Image       int32
}

// filterUTF16 把 "名称|模式|名称|模式" 编码成 Win32 过滤器格式（\x00 分隔、\x00\x00 结尾）。
// syscall.UTF16FromString 不允许内嵌 NUL，只能手动编码。
func filterUTF16(f string) []uint16 {
	return utf16.Encode([]rune(strings.ReplaceAll(f, "|", "\x00") + "\x00\x00"))
}

func mustUTF16(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		panic(err) // 调用点字符串都是字面量，不可能失败
	}
	return p
}

// foregroundOwner 取当前前台窗口作对话框属主。
// 没有属主时对话框由本 sidecar 进程创建，Windows 不让后台进程抢前台焦点，
// 弹窗会落在宿主窗口后面（第一次导出被遮挡的原因）；挂上属主后对话框成为它的
// 模态子窗口，合法置顶并居中显示。用户点导出瞬间前台正是宿主窗口。
func foregroundOwner() uintptr {
	hwnd, _, _ := procGetForegroundWindow.Call()
	return hwnd
}

// withCom 锁定 OS 线程并初始化 COM：goroutine 可能被调度到任意线程，
// 对话框 / shell API 要求运行在初始化过 COM 的 STA 线程上，期间不能换线程。
func withCom(fn func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hr, _, _ := procCoInitializeEx.Call(0, coinitApartmentThreaded)
	if hr == 0 || hr == 1 { // S_OK / S_FALSE：初始化成功才需要配对释放
		defer procCoUninitialize.Call()
	}
	fn()
}

// finishFileDialog 统一处理 Get*FileName 的返回：false 且 CommDlgExtendedError()==0 视为用户取消
func finishFileDialog(ok uintptr, read func() string) (string, error) {
	if ok == 0 {
		ce, _, _ := procCommDlgExtendedError.Call()
		if ce == 0 {
			return "", nil // 用户取消
		}
		return "", fmt.Errorf("dialog failed: CommDlgExtendedError=%d", ce)
	}
	return read(), nil
}

func nativeSaveDialog(name, filter string) (string, error) {
	n, f, ext := saveDialogDefaults(name, filter)
	filterBytes := filterUTF16(f)
	buf := make([]uint16, 32768)
	copy(buf, utf16.Encode([]rune(n)))

	ofn := &openFileNameW{
		StructSize: uint32(unsafe.Sizeof(openFileNameW{})),
		Owner:      foregroundOwner(),
		Filter:     &filterBytes[0],
		File:       &buf[0],
		MaxFile:    uint32(len(buf)),
		Title:      mustUTF16("保存文件"),
		DefExt:     mustUTF16(ext),
		Flags:      ofnOverwritePrompt | ofnHideReadOnly | ofnNoChangeDir,
	}
	var path string
	var derr error
	withCom(func() {
		ok, _, _ := procGetSaveFileNameW.Call(uintptr(unsafe.Pointer(ofn)))
		path, derr = finishFileDialog(ok, func() string { return syscall.UTF16ToString(buf) })
	})
	return path, derr
}

func nativeOpenDialog(filter string) (string, error) {
	f, ok := dialogFilters[filter]
	if !ok {
		f = dialogFilters["markdown"]
	}
	filterBytes := filterUTF16(f)
	buf := make([]uint16, 32768)

	ofn := &openFileNameW{
		StructSize: uint32(unsafe.Sizeof(openFileNameW{})),
		Owner:      foregroundOwner(),
		Filter:     &filterBytes[0],
		File:       &buf[0],
		MaxFile:    uint32(len(buf)),
		Title:      mustUTF16("打开文件"),
		Flags:      ofnFileMustExist | ofnPathMustExist | ofnHideReadOnly | ofnNoChangeDir,
	}
	var path string
	var derr error
	withCom(func() {
		ok, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(ofn)))
		path, derr = finishFileDialog(ok, func() string { return syscall.UTF16ToString(buf) })
	})
	return path, derr
}

func nativeDirDialog() (string, error) {
	bi := &browseInfoW{
		Owner: foregroundOwner(),
		Title: mustUTF16("选择要浏览 Markdown 文件的文件夹"),
		Flags: bifReturnOnlyFsDirs | bifNewDialogStyle,
	}
	var path string
	var derr error
	withCom(func() {
		pidl, _, _ := procSHBrowseForFolderW.Call(uintptr(unsafe.Pointer(bi)))
		if pidl == 0 {
			return // 用户取消
		}
		defer procCoTaskMemFree.Call(pidl)
		buf := make([]uint16, 32768)
		r, _, _ := procSHGetPathFromIDListW.Call(pidl, uintptr(unsafe.Pointer(&buf[0])))
		if r == 0 {
			derr = errors.New("dialog failed: SHGetPathFromIDListW")
			return
		}
		path = syscall.UTF16ToString(buf)
	})
	return path, derr
}
