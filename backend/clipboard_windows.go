//go:build windows

// 读系统剪贴板里的图片。DBX 的 UI 沙箱拿不到 navigator.clipboard.read() 的权限，
// 只能由后端直接调 Win32。剪贴板截图通常是 CF_DIB（BITMAPINFOHEADER + 像素），
// 这里把它转成 PNG 交给前端，前端再按普通图片落盘 / 内联。
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

var (
	clipboardUser32      = syscall.NewLazyDLL("user32.dll")
	procOpenClipboard    = clipboardUser32.NewProc("OpenClipboard")
	procCloseClipboard   = clipboardUser32.NewProc("CloseClipboard")
	procGetClipboardData = clipboardUser32.NewProc("GetClipboardData")

	clipboardKernel32 = syscall.NewLazyDLL("kernel32.dll")
	procGlobalLock    = clipboardKernel32.NewProc("GlobalLock")
	procGlobalUnlock  = clipboardKernel32.NewProc("GlobalUnlock")
	procGlobalSize    = clipboardKernel32.NewProc("GlobalSize")
)

const cfDIB = 8

func handleClipboardReadImage(_ json.RawMessage) (interface{}, *RPCError) {
	pngBytes, err := readClipboardPNG()
	if err != nil {
		return map[string]interface{}{"ok": false, "error": err.Error()}, nil
	}
	return map[string]interface{}{
		"ok":     true,
		"mime":   "image/png",
		"base64": base64.StdEncoding.EncodeToString(pngBytes),
	}, nil
}

func readClipboardPNG() ([]byte, error) {
	// OpenClipboard / GetClipboardData 必须在同一个线程上调用
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	var opened uintptr
	for i := 0; i < 12; i++ {
		opened, _, _ = procOpenClipboard.Call(0)
		if opened != 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if opened == 0 {
		return nil, errors.New("打不开系统剪贴板（可能被其他程序占用）")
	}
	defer procCloseClipboard.Call()

	h, _, _ := procGetClipboardData.Call(cfDIB)
	if h == 0 {
		return nil, errors.New("剪贴板里没有图片")
	}
	ptr, _, _ := procGlobalLock.Call(h)
	if ptr == 0 {
		return nil, errors.New("读不了剪贴板图片")
	}
	defer procGlobalUnlock.Call(h)

	size, _, _ := procGlobalSize.Call(h)
	if size < 40 {
		return nil, errors.New("剪贴板图片数据不完整")
	}
	buf := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), int(size))
	return dibToPNG(buf)
}

// dibToPNG 把 CF_DIB 内存块（BITMAPINFOHEADER + 像素）转成 PNG。拆成纯函数，便于用合成位图测试。
func dibToPNG(buf []byte) ([]byte, error) {
	headerSize := int(binary.LittleEndian.Uint32(buf[0:4]))
	if headerSize < 40 || headerSize > len(buf) {
		return nil, errors.New("剪贴板图片格式不支持")
	}
	width := int(int32(binary.LittleEndian.Uint32(buf[4:8])))
	hRaw := int32(binary.LittleEndian.Uint32(buf[8:12]))
	height := int(hRaw)
	if height < 0 {
		height = -height // 负值表示自上而下的 DIB
	}
	bitsPerPixel := int(binary.LittleEndian.Uint16(buf[14:16]))
	compression := binary.LittleEndian.Uint32(buf[16:20])
	if width <= 0 || height <= 0 || width > 20000 || height > 20000 {
		return nil, errors.New("剪贴板图片尺寸异常")
	}
	if bitsPerPixel != 24 && bitsPerPixel != 32 {
		return nil, errors.New("剪贴板图片格式不支持（只认 24/32 位）")
	}
	if compression != 0 && compression != 3 { // BI_RGB / BI_BITFIELDS
		return nil, errors.New("剪贴板图片是压缩格式，暂不支持")
	}

	bytesPerPixel := bitsPerPixel / 8
	stride := ((width*bitsPerPixel + 31) / 32) * 4
	// BI_BITFIELDS 的 3 个颜色掩码紧跟在 BITMAPINFOHEADER 后面
	dataOffset := headerSize
	if compression == 3 && headerSize == 40 {
		dataOffset += 12
	}
	if dataOffset < 0 || dataOffset+stride*height > len(buf) {
		return nil, errors.New("剪贴板图片数据不完整")
	}

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		srcY := y
		if hRaw > 0 { // 自下而上的 DIB 要翻过来
			srcY = height - 1 - y
		}
		rowStart := dataOffset + srcY*stride
		for x := 0; x < width; x++ {
			p := rowStart + x*bytesPerPixel
			b, g, r := buf[p], buf[p+1], buf[p+2]
			a := byte(0xff)
			if bytesPerPixel == 4 {
				a = buf[p+3]
			}
			img.SetRGBA(x, y, color.RGBA{R: r, G: g, B: b, A: a})
		}
	}

	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, errors.New("剪贴板图片转 PNG 失败")
	}
	return out.Bytes(), nil
}
