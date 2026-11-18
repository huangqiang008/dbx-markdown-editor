// go 指令固定 1.22：dbx-plugin dev 在 .dbx-dev/go.work 里硬编码 `go 1.22`
// （plugin-cli dev-runtime/runtime.mjs），这里高于它会导致整个后端构建失败。
// 因此 golang.org/x/image 必须停留在 v0.24.0 —— v0.25.0 起要求 go 1.23。
module mdeditor-backend

go 1.22

require golang.org/x/image v0.24.0
