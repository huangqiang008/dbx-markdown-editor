import paragraphIcon from '../../../assets/pngicon/paragraph/2.png'
import htmlIcon from '../../../assets/pngicon/html/2.png'
import hrIcon from '../../../assets/pngicon/horizontal_line/2.png'
import frontMatterIcon from '../../../assets/pngicon/front_matter/2.png'
import header1Icon from '../../../assets/pngicon/heading_1/2.png'
import header2Icon from '../../../assets/pngicon/heading_2/2.png'
import header3Icon from '../../../assets/pngicon/heading_3/2.png'
import header4Icon from '../../../assets/pngicon/heading_4/2.png'
import header5Icon from '../../../assets/pngicon/heading_5/2.png'
import header6Icon from '../../../assets/pngicon/heading_6/2.png'
import newTableIcon from '../../../assets/pngicon/new_table/2.png'
import bulletListIcon from '../../../assets/pngicon/bullet_list/2.png'
import codeIcon from '../../../assets/pngicon/code/2.png'
import quoteIcon from '../../../assets/pngicon/quote_block/2.png'
import todoListIcon from '../../../assets/pngicon/todolist/2.png'
import mathblockIcon from '../../../assets/pngicon/math/2.png'
import orderListIcon from '../../../assets/pngicon/order_list/2.png'
import flowchartIcon from '../../../assets/pngicon/flowchart/2.png'
import sequenceIcon from '../../../assets/pngicon/sequence/2.png'
import plantumlIcon from '../../../assets/pngicon/plantuml/2.png'
import mermaidIcon from '../../../assets/pngicon/mermaid/2.png'
import vegaIcon from '../../../assets/pngicon/chart/2.png'
import { isOsx } from '../../config'

const COMMAND_KEY = isOsx ? '⌘' : 'Ctrl'
const OPTION_KEY = isOsx ? '⌥' : 'Alt'
const SHIFT_KEY = isOsx ? '⇧' : 'Shift'

// Command (or Cmd) ⌘
// Shift ⇧
// Option (or Alt) ⌥
// Control (or Ctrl) ⌃
// Caps Lock ⇪
// Fn

export const quickInsertObj = {
  'basic block': [{
    title: '正文',
    subTitle: '普通段落',
    label: 'paragraph',
    shortCut: `${COMMAND_KEY}+0`,
    icon: paragraphIcon
  }, {
    title: '分割线',
    subTitle: '---',
    label: 'hr',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+-`,
    icon: hrIcon
  }, {
    title: 'YAML 元数据',
    subTitle: '--- 元数据 ---',
    label: 'front-matter',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+Y`,
    icon: frontMatterIcon
  }],
  header: [{
    title: '标题 1',
    subTitle: '# 一级标题',
    label: 'heading 1',
    shortCut: `${COMMAND_KEY}+1`,
    icon: header1Icon
  }, {
    title: '标题 2',
    subTitle: '## 二级标题',
    label: 'heading 2',
    shortCut: `${COMMAND_KEY}+2`,
    icon: header2Icon
  }, {
    title: '标题 3',
    subTitle: '### 三级标题',
    label: 'heading 3',
    shortCut: `${COMMAND_KEY}+3`,
    icon: header3Icon
  }, {
    title: '标题 4',
    subTitle: '#### 四级标题',
    label: 'heading 4',
    shortCut: `${COMMAND_KEY}+4`,
    icon: header4Icon
  }, {
    title: '标题 5',
    subTitle: '##### 五级标题',
    label: 'heading 5',
    shortCut: `${COMMAND_KEY}+5`,
    icon: header5Icon
  }, {
    title: '标题 6',
    subTitle: '###### 六级标题',
    label: 'heading 6',
    shortCut: `${COMMAND_KEY}+6`,
    icon: header6Icon
  }],
  'advanced block': [{
    title: '表格',
    subTitle: '| 列 1 | 列 2 |',
    label: 'table',
    shortCut: `${SHIFT_KEY}+${COMMAND_KEY}+T`,
    icon: newTableIcon
  }, {
    title: '块级公式',
    subTitle: '$$ 数学公式 $$',
    label: 'mathblock',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+M`,
    icon: mathblockIcon
  }, {
    title: 'HTML 块',
    subTitle: '<div>HTML 内容</div>',
    label: 'html',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+J`,
    icon: htmlIcon
  }, {
    title: '代码块',
    subTitle: '```js 代码 ```',
    label: 'pre',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+C`,
    icon: codeIcon
  }, {
    title: '引用',
    subTitle: '> 引用内容',
    label: 'blockquote',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+Q`,
    icon: quoteIcon
  }],
  'list block': [{
    title: '有序列表',
    subTitle: '1. 列表项',
    label: 'ol-order',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+O`,
    icon: orderListIcon
  }, {
    title: '无序列表',
    subTitle: '- 列表项',
    label: 'ul-bullet',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+U`,
    icon: bulletListIcon
  }, {
    title: '任务列表',
    subTitle: '- [ ] 待办事项',
    label: 'ul-task',
    shortCut: `${OPTION_KEY}+${COMMAND_KEY}+X`,
    icon: todoListIcon
  }],
  diagram: [{
    title: 'Vega 图表',
    subTitle: '使用 Vega-Lite 绘制图表',
    label: 'vega-lite',
    icon: vegaIcon
  }, {
    title: '流程图',
    subTitle: '插入流程图',
    label: 'flowchart',
    icon: flowchartIcon
  }, {
    title: '时序图',
    subTitle: '插入时序图',
    label: 'sequence',
    icon: sequenceIcon
  }, {
    title: 'PlantUML 图表',
    subTitle: '插入 PlantUML 图表',
    label: 'plantuml',
    icon: plantumlIcon
  }, {
    title: 'Mermaid 图表',
    subTitle: '插入 Mermaid 图表',
    label: 'mermaid',
    icon: mermaidIcon
  }]
}
