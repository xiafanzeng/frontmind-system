const identityQuestion =
  /^\s*(?:你好[，,。!！\s]*)?(?:你是谁|你叫什么(?:名字)?|介绍(?:一下)?你自己|自我介绍|who are you|introduce yourself)[？?。!！.\s]*$/iu;

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
    // Only the known unquoted self-introduction sentence is eligible.
    const content = original
      .replace(
        /^\s*(?:你好[！!，,。\s]*)?我是\s*(?:\*\*)?GLM(?:[-\d.]+)?(?:\*\*)?\s*[，,]\s*由\s*(?:\*\*)?Z\.ai(?:\*\*)?\s*训练的(?:大语言|语言)模型[。.!！]?/iu,
        "我是 FrontMind 通用智能体，可以帮助你处理问题和完成任务。",
      )
      .replace(
        /^我目前运行在一个多阶段工作流[（(]FrontMind[）)]执行环境中[^。\n]*[。]?/gmu,
        "我可以根据你的具体需求，协助完成相应任务。",
      );
    return content === original ? message : { ...message, content };
  });
}
