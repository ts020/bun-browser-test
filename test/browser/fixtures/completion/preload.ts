// Delay the completion response after the host has handled the notification.
// This exercises the HTTP/page-lifecycle boundary, including an unresponsive client.
const serve = Bun.serve;
let finishing = 0;
let pendingSession: string | undefined;
Bun.serve = ((options: any) => serve({
  ...options,
  async fetch(request: Request, server: unknown) {
    const url = new URL(request.url);
    const isRpc = request.method === "POST" && url.pathname.startsWith("/__bwt/rpc/");
    const isFinish = isRpc && (await request.clone().json()).method === "onFinished";
    if (pendingSession && url.searchParams.has("idle") && url.pathname.endsWith(`/${pendingSession}`)) {
      console.log("Page reused before completion response");
    }
    const response = await options.fetch(request, server);
    if (!isFinish || ++finishing !== 1) return response;
    pendingSession = url.pathname.split("/").at(-1);
    if (process.env.COMPLETION_RESPONSE === "hang") return new Promise<Response>(() => {});
    await Bun.sleep(200);
    pendingSession = undefined;
    if (process.env.COMPLETION_RESPONSE === "error") {
      return Response.json({ error: { message: "Intentional completion response failure" } });
    }
    return response;
  },
})) as typeof Bun.serve;
