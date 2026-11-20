export async function streamChatWithProviders({
  body,
  messages,
  res,
  providers,
  markFailure,
  markSuccess,
  timeoutMs = 45_000,
  fetchImpl = fetch,
  corsHeaders = {},
}) {
  const errors = [];

  for (const provider of providers) {
    if (res.destroyed) return { aborted: true, errors };

    const controller = new AbortController();
    let timedOut = false;
    let clientDisconnected = false;
    let timer;

    const onClose = () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        controller.abort(new Error("Client disconnected"));
      }
    };

    res.once("close", onClose);

    try {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("First token timeout"));
      }, timeoutMs);

      const upstream = await fetchImpl(
        `${provider.base}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${provider.key}`,
          },
          body: JSON.stringify({
            model: provider.model,
            messages,
            stream: true,
            ...(Array.isArray(body.tools) && body.tools.length
              ? { tools: body.tools, tool_choice: body.tool_choice || "auto" }
              : {}),
          }),
          signal: controller.signal,
        }
      );

      if (!upstream.ok || !upstream.body) {
        clearTimeout(timer);
        const status = upstream.status || 502;
        markFailure(
          provider,
          status,
          upstream.headers?.get?.("retry-after")
        );
        errors.push({ provider: provider.id, status });
        await upstream.body?.cancel().catch(() => {});
        continue;
      }

      const reader = upstream.body.getReader();
      let first;

      // Ignore empty chunks. The deadline ends only when actual bytes arrive.
      while (true) {
        first = await reader.read();
        if (first.done || first.value?.byteLength) break;
      }

      if (clientDisconnected || res.destroyed) {
        await reader.cancel().catch(() => {});
        return { aborted: true, errors };
      }

      if (first.done) {
        clearTimeout(timer);
        markFailure(provider, 0);
        errors.push({ provider: provider.id, status: "empty_stream" });
        continue;
      }

      clearTimeout(timer);
      markSuccess(provider);

      console.log(
        `[exile] chat via ${provider.id} (${provider.keyName})`
      );

      res.writeHead(200, {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const decoder = new TextDecoder();
      res.write(decoder.decode(first.value, { stream: true }));

      while (true) {
        const { done, value } = await reader.read();

        if (clientDisconnected || res.destroyed) {
          await reader.cancel().catch(() => {});
          return { aborted: true, errors };
        }

        if (done) break;
        if (value?.byteLength) {
          res.write(decoder.decode(value, { stream: true }));
        }
      }

      const remaining = decoder.decode();
      if (remaining) res.write(remaining);
      if (!res.destroyed) res.end();

      return { ok: true, errors };
    } catch (error) {
      if (clientDisconnected || res.destroyed) {
        return { aborted: true, errors };
      }

      if (res.headersSent) {
        console.warn("[exile] chat stream interrupted after response began");
        if (!res.destroyed) res.end();
        return { interrupted: true, errors };
      }

      markFailure(provider, 0);

      const status = timedOut
        ? "first_token_timeout"
        : "stream_start_failed";

      errors.push({ provider: provider.id, status });
    } finally {
      clearTimeout(timer);
      res.removeListener("close", onClose);
    }
  }

  return { ok: false, errors };
}
