import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import {
  API_VERSION,
  CreateReplaySchema,
  CreateRunSchema,
  parse_json_strict,
} from "@verdict/protocol";
import { Engine } from "./engine.js";
import { WalletReviews } from "./wallet.js";
import { WalletReceiptWatches } from "./wallet-receipt-watch.js";
import { PaymentDefense } from "./payment-defense.js";
import { authenticateDefense,requireRole } from "./defense-auth.js";
import { AgentService } from "./agent-service.js";
import { ModelSettings } from "./model-settings.js";
import { ApiError } from "./store.js";
import { type ServerConfig } from "./config.js";
import { call_tool, describe_environment, tool_catalog } from "./tools.js";
export { Engine, reports_consistent } from "./engine.js";
export {
  load_server_config,
  ServerConfigSchema,
  trusted_context,
  type ServerConfig,
} from "./config.js";
export { ApiError } from "./store.js";

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new ApiError(415, "JSON_REQUIRED");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new ApiError(413, "BODY_LIMIT");
    chunks.push(chunk);
  }
  try {
    return parse_json_strict(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON");
  }
}
function send(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
export function start_server(config: ServerConfig, launchId = "foreground") {
  const engine = new Engine(config);
  let modelSettings: ModelSettings;
  try { modelSettings = new ModelSettings([config, engine.config]); }
  catch (error) { engine.store.close(); throw error; }
  const agents = new AgentService(engine);
  const wallet = new WalletReviews(engine.store, config, agents.graph, agents.observer.record);
  const receiptWatches = new WalletReceiptWatches(engine.store, config, wallet);
  const defense = config.defense?new PaymentDefense(engine.store,config,wallet,receiptWatches):undefined;
  let observationJob: Promise<unknown> | null = null;
  const server = createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      // Loopback binding + host/origin checks keep browser-based DNS rebinding from submitting jobs.
      const host = req.headers.host?.split(":")[0];
      if (!host || !["localhost", "127.0.0.1"].includes(host))
        throw new ApiError(403, "HOST_NOT_ALLOWED");
      if (origin) {
        if (!engine.config.corsOrigins.includes(origin))
          throw new ApiError(403, "ORIGIN_NOT_ALLOWED");
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type,authorization");
        res.writeHead(204);
        res.end();
        return;
      }
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if(path.startsWith('/api/defense/')){
        const p=authenticateDefense(config,req.headers.authorization),service=defense!;
        const list=path.match(/^\/api\/defense\/(authorizations|tasks|proposals)$/);
        if(list&&req.method==='GET'){send(res,200,service.list(p,list[1] as 'authorizations'|'tasks'|'proposals',new URL(req.url!,'http://localhost').searchParams));return;}
        if(path==='/api/defense/meta'&&req.method==='GET'){send(res,200,{schemaVersion:'defense-api-v1',principal:{id:p.id,tenantId:p.tenantId,role:p.role},wallet:wallet.info()});return;}
        if(path==='/api/defense/sessions'&&req.method==='POST'){send(res,201,service.createSession(p,await body(req)));return;}
        const session=path.match(/^\/api\/defense\/sessions\/([\w-]+)$/);
        if(session&&req.method==='POST'){send(res,200,service.updateSession(p,session[1],await body(req)));return;}
        if(path==='/api/defense/authorizations'&&req.method==='POST'){send(res,201,service.createAuthorization(p,await body(req)));return;}
        const auth=path.match(/^\/api\/defense\/authorizations\/([\w-]+)(?:\/(revise|revoke))?$/);
        if(auth){
          if(req.method==='GET'&&!auth[2]){const params=new URL(req.url!,'http://localhost').searchParams;const q=z.strictObject({version:z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().safe()).optional()}).parse(Object.fromEntries(params));send(res,200,service.getAuthorization(p,auth[1],q.version));return;}
          if(req.method==='POST'&&auth[2]){send(res,200,auth[2]==='revise'?service.reviseAuthorization(p,auth[1],await body(req)):service.revokeAuthorization(p,auth[1],await body(req)));return;}
        }
        if(path==='/api/defense/tasks'&&req.method==='POST'){send(res,201,service.createTask(p,await body(req)));return;}
        const task=path.match(/^\/api\/defense\/tasks\/([\w-]+)(?:\/(cancel))?$/);
        if(task){
          if(req.method==='GET'&&!task[2]){send(res,200,service.viewTask(p,task[1]));return;}
          if(req.method==='POST'&&task[2]){z.strictObject({}).parse(await body(req));send(res,200,service.cancelTask(p,task[1]));return;}
        }
        if(path==='/api/defense/proposals'&&req.method==='POST'){send(res,202,service.createProposal(p,await body(req)));return;}
        const proposal=path.match(/^\/api\/defense\/proposals\/([\w-]+)(?:\/(confirm|override|consume|cancel|broadcast|audit|graph|evidence))?$/);
        if(proposal){
          const [,id,action]=proposal;
          if(req.method==='GET'){
            if(!action){send(res,200,service.viewProposal(p,id));return;}
            if(action==='audit'){send(res,200,{events:service.auditProposal(p,id)});return;}
            if(action==='graph'){const q=new URL(req.url!,'http://localhost').searchParams;send(res,200,agents.graph.walletPage(service.graph(p,id),Number(q.get('after')??0),Number(q.get('limit')??200)));return;}
            if(action==='evidence'){send(res,200,service.evidence(p,id));return;}
          }
          if(req.method==='POST'){
            if(action==='confirm'||action==='override'){send(res,200,service.confirmProposal(p,id,await body(req),action==='override'));return;}
            if(action==='consume'){send(res,200,await service.consumeProposal(p,id,await body(req)));return;}
            if(action==='broadcast'){send(res,200,await service.report(p,id,await body(req)));return;}
            if(action==='cancel'){z.strictObject({}).parse(await body(req));send(res,200,service.cancelProposal(p,id));return;}
          }
        }
        const watch=path.match(/^\/api\/defense\/proposals\/([\w-]+)\/receipt\/(recheck|watch|finality)(?:\/(stop|resume))?$/);
        if(watch){const [,id,kind,action]=watch;
          if(req.method==='GET'&&kind==='watch'&&!action){send(res,200,service.watch(p,id,'get'));return;}
          if(req.method==='POST'){z.strictObject({}).parse(await body(req));send(res,200,kind==='finality'?await wallet.observeFinality(service.graph(p,id)):kind==='recheck'?await service.recheck(p,id):service.watch(p,id,action==='stop'?'stop':action==='resume'?'resume':'start'));return;}
        }
        if(path==='/api/defense/evidence/replay'&&req.method==='POST'){requireRole(p,'OWNER','EXECUTOR');send(res,200,await wallet.replayEvidence(await body(req),false));return;}
        throw new ApiError(404,'NOT_FOUND');
      }
      if(config.defense)throw new ApiError(403,'DEFENSE_API_REQUIRED');
      if(req.method==='GET'&&path==='/api/settings/models'){send(res,200,modelSettings.read());return;}
      const modelSettingsRoute=path.match(/^\/api\/settings\/models\/(agent|guard)$/);
      if(req.method==='POST'&&modelSettingsRoute){
        const input=await body(req);
        send(res,200,modelSettings.update(modelSettingsRoute[1] as 'agent'|'guard',input,agents.modelSettingsBusy||wallet.modelSettingsBusy));return;
      }
      if(req.method==='GET'&&path==='/api/wallet/meta'){send(res,200,wallet.info());return;}
      if(req.method==='POST'&&path==='/api/wallet/sessions'){send(res,201,wallet.sessions.create(await body(req)));return;}
      const walletSessionRoute=path.match(/^\/api\/wallet\/sessions\/([\w-]+)$/);
      if(walletSessionRoute&&req.method==='POST'){send(res,200,wallet.updateSession(walletSessionRoute[1],await body(req)));return;}
      if(req.method==='POST'&&path==='/api/wallet/reviews'){send(res,202,wallet.create(await body(req)));return;}
      if(req.method==='GET'&&path==='/api/wallet/reviews'){send(res,200,wallet.list(new URL(req.url!,'http://localhost').searchParams));return;}
      if(req.method==='POST'&&path==='/api/wallet/evidence/replay'){send(res,200,await wallet.replayEvidence(await body(req)));return;}
      const walletEvidenceRoute=path.match(/^\/api\/wallet\/evidence\/(0x[0-9a-f]{64})$/);
      if(req.method==='GET'&&walletEvidenceRoute){send(res,200,wallet.evidence.read(walletEvidenceRoute[1]));return;}
      const walletGraphRoute=path.match(/^\/api\/wallet\/reviews\/([\w-]+)\/graph$/);
      if(req.method==='GET'&&walletGraphRoute){const query=new URL(req.url!,'http://localhost').searchParams;send(res,200,agents.graph.walletPage(walletGraphRoute[1],Number(query.get('after')??0),Number(query.get('limit')??200)));return;}
      const walletActionsRoute=path.match(/^\/api\/wallet\/reviews\/([\w-]+)\/actions$/);
      if(req.method==='GET'&&walletActionsRoute){send(res,200,wallet.actions(walletActionsRoute[1]));return;}
      const receiptRecheck=path.match(/^\/api\/wallet\/reviews\/([\w-]+)\/receipt\/recheck$/);
      if(req.method==='POST'&&receiptRecheck){z.strictObject({}).parse(await body(req));send(res,200,await wallet.recheckReceipt(receiptRecheck[1]));return;}
      const finality=path.match(/^\/api\/wallet\/reviews\/([\w-]+)\/receipt\/finality$/);
      if(req.method==='POST'&&finality){z.strictObject({}).parse(await body(req));send(res,200,await wallet.observeFinality(finality[1]));return;}
      const receiptWatch=path.match(/^\/api\/wallet\/reviews\/([\w-]+)\/receipt\/watch(?:\/(stop|resume))?$/);
      if(receiptWatch){
        if(req.method==='GET'&&!receiptWatch[2]){send(res,200,receiptWatches.get(receiptWatch[1]));return;}
        if(req.method==='POST'){
          z.strictObject({}).parse(await body(req));
          const [,id,action]=receiptWatch;
          send(res,action==='stop'?200:202,action==='stop'?receiptWatches.stop(id):action==='resume'?receiptWatches.resume(id):receiptWatches.start(id));return;
        }
      }
      const walletRoute=path.match(/^\/api\/wallet\/reviews\/([\w-]+)(?:\/(confirm|override|consume|cancel|broadcast))?$/);
      if(walletRoute){
        const [,id,action]=walletRoute;
        if(req.method==='GET'&&!action){send(res,200,wallet.get(id));return;}
        if(req.method==='POST'&&action==='confirm'){send(res,200,wallet.confirm(id,await body(req)));return;}
        if(req.method==='POST'&&action==='override'){send(res,200,wallet.overrideRisk(id,await body(req)));return;}
        if(req.method==='POST'&&action==='consume'){send(res,200,await wallet.consume(id,await body(req)));return;}
        if(req.method==='POST'&&action==='cancel'){z.strictObject({}).parse(await body(req));send(res,200,wallet.cancel(id));return;}
        if(req.method==='POST'&&action==='broadcast'){send(res,200,await wallet.broadcast(id,await body(req)));return;}
      }
      if(req.method==='POST' && path==='/api/guard/reports/import'){send(res,200,agents.reports.import(await body(req)));return;}
      if(req.method==='GET' && path==='/api/guard/reports'){send(res,200,agents.reports.list());return;}
      const exportedReportRoute=path.match(/^\/api\/guard\/exports\/(0x[0-9a-f]{64})$/);
      if(req.method==='GET' && exportedReportRoute){send(res,200,agents.reports.exported(exportedReportRoute[1]));return;}
      if(req.method==='GET' && path==='/api/guard/tasks'){send(res,200,agents.guardTasks());return;}
      if(req.method==='GET' && path==='/api/guard/rules'){send(res,200,agents.reports.rules());return;}
      const reportRoute=path.match(/^\/api\/guard\/reports\/(0x[0-9a-f]{64})(?:\/(candidate|replay))?$/);
      if(reportRoute && req.method==='GET' && !reportRoute[2]){send(res,200,agents.reports.get(reportRoute[1]));return;}
      if(reportRoute && req.method==='POST' && reportRoute[2]==='replay'){send(res,200,await agents.replayIncident(reportRoute[1],await body(req)));return;}
      if(reportRoute && req.method==='POST' && reportRoute[2]==='candidate'){send(res,200,agents.reports.candidate(reportRoute[1]));return;}
      const exportRoute=path.match(/^\/api\/guard\/tasks\/([\w-]+)\/decisions\/(\d+)\/export$/);
      if(req.method==='POST' && exportRoute){send(res,200,agents.exportIncident(exportRoute[1],Number(exportRoute[2]),await body(req)));return;}
      if(req.method==='GET' && exportRoute){send(res,200,agents.exportIncident(exportRoute[1],Number(exportRoute[2])));return;}
      const graphRoute=path.match(/^\/api\/agent\/runs\/([\w-]+)\/graph$/);
      if(req.method==='GET'&&graphRoute){
        const after=Number(new URL(req.url!,'http://localhost').searchParams.get('after')??0);
        if(!Number.isSafeInteger(after)||after<0)throw new ApiError(400,'INVALID_CURSOR');
        send(res,200,agents.graph.page(graphRoute[1],after));return;
      }
      const observerRoute=path.match(/^\/api\/agent\/runs\/([\w-]+)\/observability$/);
      if(req.method==='GET'&&observerRoute){agents.store.agent(observerRoute[1]);send(res,200,{...agents.observer.info(),sessionURL:agents.observer.sessionURL(observerRoute[1])});return;}
      const guardRoute=path.match(/^\/api\/guard\/tasks\/([\w-]+)$/);
      if(req.method==='GET' && guardRoute){send(res,200,agents.guard.state(guardRoute[1]));return;}
      const telemetryRoute=path.match(/^\/api\/guard\/tasks\/([\w-]+)\/telemetry(?:\/(import))?$/);
      if(req.method==='GET' && telemetryRoute && !telemetryRoute[2]){send(res,200,await agents.guardTelemetry(telemetryRoute[1]));return;}
      if(req.method==='POST' && telemetryRoute && telemetryRoute[2]==='import'){send(res,200,agents.guardTelemetryImport(telemetryRoute[1],await body(req)));return;}
      if (req.method === "GET" && path === "/api/agent/meta") {
        send(res, 200, agents.info());
        return;
      }
      if (req.method === "POST" && path === "/api/agent/runs") {
        send(res, 202, agents.createAgent(await body(req)));
        return;
      }
      if (req.method === "POST" && path === "/api/agent/drafts") {
        send(res, 202, agents.createDraft(await body(req)));
        return;
      }
      const draftRoute = path.match(
        /^\/api\/agent\/drafts\/([\w-]+)(?:\/(revise|confirm))?$/,
      );
      if (draftRoute) {
        const [, id, action] = draftRoute;
        if (req.method === "GET" && !action) {
          send(res, 200, agents.draft(id));
          return;
        }
        if (req.method === "POST" && action === "revise") {
          send(res, 200, agents.reviseDraft(id, await body(req)));
          return;
        }
        if (req.method === "POST" && action === "confirm") {
          send(res, 202, agents.confirmDraft(id, await body(req)));
          return;
        }
      }
      const agentRoute = path.match(
        /^\/api\/agent\/runs\/([\w-]+)(?:\/(events|stop))?$/,
      );
      if (agentRoute) {
        const [, id, action] = agentRoute;
        if (req.method === "GET" && !action) {
          send(res, 200, agents.store.agent(id));
          return;
        }
        if (req.method === "GET" && action === "events") {
          const after = Number(
            new URL(req.url!, "http://localhost").searchParams.get("after") ??
              0,
          );
          if (!Number.isSafeInteger(after) || after < 0)
            throw new ApiError(400, "INVALID_CURSOR");
          send(res, 200, { events: agents.store.events(id, after) });
          return;
        }
        if (req.method === "POST" && action === "stop") {
          z.strictObject({}).parse(await body(req));
          send(res, 200, agents.stop(id));
          return;
        }
      }
      if (req.method === "GET" && path === "/health") {
        send(res, 200, {
          instanceId: config.instanceId,
          apiVersion: API_VERSION,
          launchId,
        });
        return;
      }
      if (req.method === "GET" && path === "/api/meta") {
        send(res, 200, describe_environment(engine));
        return;
      }
      if (req.method === "GET" && path === "/api/tools") {
        send(res, 200, { apiVersion: API_VERSION, tools: tool_catalog });
        return;
      }
      if (req.method === "POST" && path === "/api/tools/call") {
        send(res, 200, { apiVersion: API_VERSION, result: await call_tool(engine, await body(req)) });
        return;
      }
      if (req.method === "GET" && path === "/api/services") {
        send(res, 200, {
          apiVersion: API_VERSION,
          candidates: await engine.candidates(),
        });
        return;
      }
      if (req.method === "POST" && path === "/api/selection") {
        send(res, 200, {
          apiVersion: API_VERSION,
          candidates: await engine.candidates(
            CreateRunSchema.parse(await body(req)),
          ),
        });
        return;
      }
      if (req.method === "POST" && path === "/api/runs") {
        send(res, 202, engine.createRun(await body(req)));
        return;
      }
      const run = path.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === "GET" && run) {
        send(res, 200, engine.store.run(run[1]));
        return;
      }
      if (req.method === "POST" && path === "/api/evidence/import") {
        send(res, 200, await engine.importEvidence(await body(req)));
        return;
      }
      if (req.method === "GET" && path === "/api/evidence") {
        send(res, 200, {
          evidence: engine.store.evidenceRows().map((r) => ({
            evidenceId: r.id,
            contextId: r.contextId,
            createdAt: r.createdAt,
            publication: r.publication,
          })),
        });
        return;
      }
      const evidence = path.match(
        /^\/api\/evidence\/(0x[0-9a-f]{64})(?:\/(bundle|manifest))?$/,
      );
      if (req.method === "GET" && evidence) {
        const row = engine.store.evidenceRow(evidence[1]);
        if (evidence[2] === "manifest") {
          send(res, 200, row.manifest);
          return;
        }
        if (evidence[2] === "bundle") {
          const stored = engine.store.readEvidence(row.id);
          res.writeHead(200, {
            "content-type": "application/json",
            "content-disposition": `attachment; filename="${row.id}.json"`,
            "x-content-type-options": "nosniff",
          });
          res.end(stored.bytes);
          return;
        }
        let integrity = "VERIFIED";
        try {
          engine.store.readEvidence(row.id);
        } catch (e) {
          integrity =
            e instanceof ApiError && e.message === "ARTIFACT_MISMATCH"
              ? "MISMATCH"
              : "UNAVAILABLE";
        }
        send(res, 200, {
          evidenceId: row.id,
          manifest: row.manifest,
          artifactIntegrity: integrity,
          contextId: row.contextId,
          evaluatedAt: row.evaluatedAt,
          publication: row.publication,
          bundleUrl: `/api/evidence/${row.id}/bundle`,
          replays: engine.store
            .replays()
            .filter((r) => r.evidenceId === row.id),
        });
        return;
      }
      if (req.method === "POST" && path === "/api/replays") {
        const input = CreateReplaySchema.parse(await body(req));
        send(res, 202, {
          replayId: engine.createReplay(input.evidenceId, input.contextId),
        });
        return;
      }
      const replay = path.match(/^\/api\/replays\/([\w-]+)$/);
      if (req.method === "GET" && replay) {
        send(res, 200, engine.store.replay(replay[1]));
        return;
      }
      if (req.method === "GET" && path === "/api/observations") {
        send(res, 200, { observations: engine.store.observations() });
        return;
      }
      if (req.method === "POST" && path === "/api/observations") {
        z.strictObject({}).parse(await body(req));
        if (!observationJob)
          observationJob = engine.observeRpc().finally(() => {
            observationJob = null;
          });
        send(res, 200, { observations: await observationJob });
        return;
      }
      throw new ApiError(404, "NOT_FOUND");
    } catch (e) {
      if (!res.headersSent)
        send(
          res,
          e instanceof ApiError ? e.code : e instanceof z.ZodError ? 400 : 500,
          {
            error:
              e instanceof ApiError
                ? e.message
                : e instanceof z.ZodError
                  ? "INVALID_INPUT"
                  : "INTERNAL_ERROR",
          },
        );
      else res.end();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () =>
      resolve((server.address() as { port: number }).port),
    );
  });
  return {
    engine,
    agents,
    wallet,
    receiptWatches,
    defense,
    server,
    ready,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await observationJob;
      await Promise.all([receiptWatches.close(),wallet.close()]);
      await agents.close();
      await engine.close();
      modelSettings.close();
    },
  };
}
