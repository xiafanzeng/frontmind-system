import { fromMarkdown } from "mdast-util-from-markdown";
const identityQuestion =
  /^\s*(?:你好[，,。!！\s]*)?(?:你是谁|你是什么模型|你是哪个模型|你叫什么(?:名字)?|介绍(?:一下)?你自己|自我介绍|who are you|introduce yourself)[？?。!！.\s]*$/iu;

/** Display-only repair for old identity replies, never a provider-name replacement. */
export function projectFrontMindIdentityMessages<
  T extends { role: string; content: string },
>(messages: T[]): T[] {
  let identityReply = false;
  return messages.map((message) => {
    if (message.role === "user") {
      identityReply = identityQuestion.test(message.content);
      return message;
    }
    if (!identityReply || message.role !== "assistant") return message;
    const original = message.content;
    // Repair only top-level identity prose. Quotes, links, inline/fenced code and
    // explicit technical questions remain exactly as stored.
    const changes: Array<{ start: number; end: number; text: string }> = [];
    for (const node of fromMarkdown(original).children) {
      if (
        node.type !== "paragraph" ||
        node.position?.start.offset === undefined ||
        node.position.end.offset === undefined
      )
        continue;
      const protectedContent = (value: any): boolean =>
        [
          "link",
          "linkReference",
          "inlineCode",
          "html",
          "image",
          "imageReference",
        ].includes(value.type) ||
        (value.children?.some(protectedContent) ?? false);
      if (protectedContent(node)) continue;
      const start = node.position.start.offset;
      const end = node.position.end.offset;
      const paragraph = original.slice(start, end);
      const knownModelParagraph =
        /^关于底层模型[：:]\s*我当前使用的底层模型是\s*(?:\*\*)?GLM-5\.3(?:\*\*)?[，,]由(?:\*\*)?智谱[（(]Z\.ai[）)](?:\*\*)?训练提供。FrontMind 是提供相关服务的产品层，本身并不训练模型。$/u.test(
          paragraph.replace(/\\\*/gu, "*"),
        );
      const text = knownModelParagraph
        ? ""
        : paragraph
            .replace(
              /^\s*(?:你好[！!，,。\s]*)?我是\s*(?:\*\*)?GLM(?:[-\d.]+)?(?:\*\*)?\s*[，,]\s*由\s*(?:\*\*)?Z\.ai(?:\*\*)?\s*训练的(?:大语言|语言)模型[。.!！]?/iu,
              "我是 FrontMind 通用智能体，可以帮助你处理问题和完成任务。",
            )
            .replace(
              /^我目前运行在一个多阶段工作流[（(]FrontMind[）)]执行环境中[^。\n]*[。]?/gmu,
              "我可以根据你的具体需求，协助完成相应任务。",
            )
            .replace(
              /^(?:补充说明[：:]\s*)?(?:我的|当前的?|本会话的?)?底层模型(?:是|为|[：:])\s*(?:\*\*)?GLM[-–‑\d.]+(?:\*\*)?(?:[，,]\s*由(?:智谱|Z\.ai)(?:提供|训练))?[。.!！]?\s*$/iu,
              "",
            );
      if (text !== paragraph) changes.push({ start, end, text });
    }
    let content = original;
    for (const change of changes.reverse())
      content =
        content.slice(0, change.start) +
        change.text +
        content.slice(change.end);
    if (content !== original && !content.trim())
      content = "我是 FrontMind 通用智能体，可以帮助你处理问题和完成任务。";
    return content === original ? message : { ...message, content };
  });
}
