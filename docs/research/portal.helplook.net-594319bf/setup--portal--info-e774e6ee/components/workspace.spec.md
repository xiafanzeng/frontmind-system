# knowledge-frontend组件规格

## 结构
保留MindPromise外层导航。局部导航：知识库前台→站点设置、个性化配置（导航栏、主页、页脚）、AI友好官网。站点设置顶部9标签：站点信息、SEO配置、自定义域名、多语言配置、嵌入代码、文章、栏目、搜索、通知。主表单独立滚动，保存固定。个性化配置为设置/预览两栏。

## 计算样式与限制
监控body Computed实测：background rgb(245,246,250)，color rgb(20,22,41)，font-family Inter,-apple-system,system-ui,Segoe UI,sans-serif，line-height24px，min-width320px，overflow hidden。其他尺寸/状态颜色依据截图适配，尚未完整获取getComputedStyle，不称为已实测。

## 交互
React本地状态、原生表单和Radix弹层。键盘可达、焦点可见、Escape关闭并返回触发器。监控表单左侧约46%右侧54%；知识库设置局部栏约220px，模板四列、蓝色选中边框、白色面板。所有保存/执行只在本地Mock进行。

## 文案与资产
采用已观察的通用控件名称。品牌、问题、统计为明确合成数据。使用自有图标和模板示意，禁止复制账号TokenCookie和业务原文。

## 响应式
本次新增复刻只验收桌面；保留现有移动导航。
