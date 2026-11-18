//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"testing"
)

func dibHeader(width, height int32, bpp uint16, compression uint32) []byte {
	b := make([]byte, 40)
	binary.LittleEndian.PutUint32(b[0:4], 40) // biSize
	binary.LittleEndian.PutUint32(b[4:8], uint32(width))
	binary.LittleEndian.PutUint32(b[8:12], uint32(height))
	binary.LittleEndian.PutUint16(b[12:14], 1) // biPlanes
	binary.LittleEndian.PutUint16(b[14:16], bpp)
	binary.LittleEndian.PutUint32(b[16:20], compression)
	return b
}

func TestDibToPNGBottomUp24(t *testing.T) {
	// 4x2、24 位、自下而上（Windows 截图最常见）：缓冲区第一行其实是图片最后一行
	buf := dibHeader(4, 2, 24, 0)
	const stride = 12
	buf = append(buf, make([]byte, stride*2)...)
	for x := 0; x < 4; x++ { // 缓冲区第 0 行 → 图片底部，绿色
		p := x * 3
		buf[40+p], buf[40+p+1], buf[40+p+2] = 0, 255, 0
	}
	for x := 0; x < 4; x++ { // 缓冲区第 1 行 → 图片顶部，红色
		p := 40 + stride + x*3
		buf[p], buf[p+1], buf[p+2] = 0, 0, 255
	}
	out, err := dibToPNG(buf)
	if err != nil {
		t.Fatalf("dibToPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	if img.Bounds().Dx() != 4 || img.Bounds().Dy() != 2 {
		t.Fatalf("size = %v", img.Bounds())
	}
	r, g, b, _ := img.At(0, 0).RGBA()
	if r>>8 != 255 || g>>8 != 0 || b>>8 != 0 {
		t.Fatalf("top pixel = %d %d %d, want red", r>>8, g>>8, b>>8)
	}
	r, g, b, _ = img.At(0, 1).RGBA()
	if r>>8 != 0 || g>>8 != 255 || b>>8 != 0 {
		t.Fatalf("bottom pixel = %d %d %d, want green", r>>8, g>>8, b>>8)
	}
}

func TestDibToPNGTopDown32Alpha(t *testing.T) {
	// 高度负值 = 自上而下；32 位带 alpha
	buf := dibHeader(2, -1, 32, 0)
	buf = append(buf, make([]byte, 8)...)
	pixels := []byte{0, 0, 255, 128, 255, 0, 0, 255} // 半透明红、不透明绿
	copy(buf[40:], pixels)
	out, err := dibToPNG(buf)
	if err != nil {
		t.Fatalf("dibToPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	if img.Bounds().Dx() != 2 || img.Bounds().Dy() != 1 {
		t.Fatalf("size = %v", img.Bounds())
	}
	_, g, _, a := img.At(0, 0).RGBA()
	if g>>8 != 0 || a>>8 != 128 {
		t.Fatalf("alpha pixel = g=%d a=%d, want g=0 a=128", g>>8, a>>8)
	}
}

func TestDibToPNGRejectsTruncated(t *testing.T) {
	buf := dibHeader(100, 100, 24, 0)
	if _, err := dibToPNG(buf); err == nil {
		t.Fatal("truncated DIB should fail")
	}
}
