// 收件箱的**输入分类**：捕获框里那一段文本到底算链接还是文字。
//
// 单独成文件而不是写在 view.jsx 里：视图层（jsx）在单测里跑不起来，而这条判据
// 出过真 bug——曾经先把空白删掉再判，「https://a.com 看一下」这种 URL 打头、
// 后面还有话的混排会被整条存成链接。纯函数 + 单测是钉住它的唯一办法。
//
// 判据：**整行**就是一个 URL（原文不含任何空白）才算链接条目。混排文字一律走
// 文字路径，由 service 的 extractLinks() 把里面的 URL 抽进 links，原文一字不动。

export function looksLikeLink(text) {
  return /^https?:\/\/\S+$/i.test(String(text ?? '').trim());
}
