const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '../..')
const frontendRoot = path.resolve(__dirname, '..')
const outputDir = path.join(projectRoot, 'ui/typedown/licenses')

const licenses = [
  ['typedown-frontend/LICENSE', 'Typedown-MIT.txt'],
  ['typedown-frontend/node_modules/katex/LICENSE', 'KaTeX-MIT.txt'],
  ['typedown-frontend/node_modules/mermaid/LICENSE', 'Mermaid-MIT.txt'],
  ['typedown-frontend/node_modules/react/LICENSE', 'React-MIT.txt'],
  ['typedown-frontend/node_modules/codemirror/LICENSE', 'CodeMirror-MIT.txt'],
  ['typedown-frontend/node_modules/@marktext/file-icons/LICENSE', 'MarkText-File-Icons-MIT.txt'],
  ['typedown-frontend/node_modules/file-icons/LICENSE.md', 'Atom-File-Icons-MIT.txt'],
  ['typedown-frontend/node_modules/snapsvg/LICENSE', 'SnapSVG-Apache-2.0.txt'],
  ['typedown-frontend/src/components/Muya/lib/parser/marked/LICENSE', 'Marked-MIT.txt'],
  ['typedown-frontend/src/components/Muya/themes/fonts/open-sans-LICENSE.txt', 'Open-Sans-Apache-2.0.txt'],
  ['typedown-frontend/src/components/Muya/themes/fonts/DejaVuSansMono_LICENSE', 'DejaVuSansMono-License.txt'],
  ['typedown-frontend/public/licenses/Daniel-Font.txt', 'Daniel-Font.txt'],
  ['typedown-frontend/public/licenses/js-sequence-diagrams-BSD.txt', 'js-sequence-diagrams-BSD.txt'],
  ['typedown-frontend/public/licenses/Go-Authors-BSD.txt', 'Go-Authors-BSD.txt'],
  ['typedown-frontend/public/licenses/Apache-2.0.txt', 'KaTeX-Fonts-Apache-2.0.txt'],
  ['typedown-frontend/public/licenses/SIL-OFL-1.1.txt', 'SIL-OFL-1.1.txt'],
]

fs.mkdirSync(outputDir, { recursive: true })
fs.copyFileSync(path.join(projectRoot, 'LICENSE'), path.join(projectRoot, 'ui/typedown/PROJECT-LICENSE.txt'))

for (const [source, destination] of licenses) {
  const sourcePath = path.resolve(projectRoot, source)
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing license source: ${source}`)
  }
  fs.copyFileSync(sourcePath, path.join(outputDir, destination))
}

const notices = path.join(frontendRoot, 'public/THIRD-PARTY-NOTICES.txt')
fs.copyFileSync(notices, path.join(projectRoot, 'ui/typedown/THIRD-PARTY-NOTICES.txt'))
