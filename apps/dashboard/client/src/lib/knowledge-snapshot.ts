async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || payload?.message || `请求失败 (${response.status})`;
  } catch {
    return `请求失败 (${response.status})`;
  }
}

export async function syncKnowledgeBaseArchiveFromOutput(input: {
  conversationId: string;
}) {
  const response = await fetch("/api/dashboard/knowledge/publish", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: input.conversationId }),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  window.dispatchEvent(new CustomEvent("frontmind:knowledge-base-updated"));
  return true;
}
