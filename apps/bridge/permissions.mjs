import { createHash } from 'node:crypto';
import { requestFingerprint, BridgeError } from '../../packages/protocol/contracts.mjs';
import { ThreadCreationClient } from './thread-creation.mjs';

const presets = [
  { id: 'default', label: '默认权限', description: '在沙盒中运行命令', profile: ':workspace', policy: 'on-request' },
  { id: 'auto-review', label: '自动审查', description: '自动审查提权请求', profile: ':workspace', policy: 'on-request' },
  { id: 'read-only', label: '只读', description: '编辑文件或运行命令需经批准', profile: ':read-only', policy: 'on-request' },
  { id: 'full-access', label: '完整访问权限', description: '电脑完整访问权限（风险较高）', profile: ':danger-full-access', policy: 'never' },
];
/** 只投影桌面当前权限；历史轮次和模型设置不能代替当前权限。 */
export function permissionState(state) {
  const p = state?.latestThreadSettings ?? {}, profile = p.activePermissionProfile?.id ?? p.permissions ?? null;
  const sandbox = p.sandboxPolicy ?? null, policy = p.approvalPolicy ?? null, reviewer = p.approvalsReviewer ?? null;
  const revision = createHash('sha256').update(JSON.stringify([profile,sandbox,policy,reviewer])).digest('hex');
  let mode = policy == null || reviewer == null || (profile == null && sandbox == null) ? 'unknown' : 'custom';
  const kind = profile ?? (sandbox?.type === 'readOnly' ? ':read-only' : sandbox?.type === 'dangerFullAccess' ? ':danger-full-access' : sandbox?.type === 'workspaceWrite' && sandbox.networkAccess !== true ? ':workspace' : null);
  if (policy === 'on-request' && kind === ':workspace' && reviewer === 'user') mode = 'default';
  if (policy === 'on-request' && kind === ':workspace' && ['auto_review','guardian_subagent'].includes(reviewer)) mode = 'auto-review';
  if (policy === 'on-request' && kind === ':read-only' && reviewer === 'user') mode = 'read-only';
  if (policy === 'never' && kind === ':danger-full-access' && reviewer === 'user') mode = 'full-access';
  return { mode, revision };
}

/** 配置、托管限制和内置档案全部通过原生只读接口读取，不回传原始配置。 */
export class PermissionCatalog {
  constructor({ creation = new ThreadCreationClient() } = {}) { this.creation = creation; }
  async capabilities(cwd) {
    return this.creation.run(cwd, async request => {
      const config = (await request('config/read', { cwd, includeLayers: false })).config;
      const response = await request('configRequirements/read', {});
      const profiles = await request('permissionProfile/list', { cwd });
      if (!config || !Object.hasOwn(response,'requirements') || !Array.isArray(profiles.data)) throw new BridgeError('PERMISSIONS_UNAVAILABLE','无法读取电脑权限能力，请重新读取');
      const requirements = response.requirements ?? {};
      // 当前桌面保留旧审查名称；新配置或托管要求明确使用新名称时采用新版字段。
      const reviewers = requirements.allowedApprovalsReviewers;
      const reviewer = config.approvals_reviewer === 'auto_review' || (Array.isArray(reviewers) && reviewers.includes('auto_review')) ? 'auto_review' : 'guardian_subagent';
      const options = presets.map(p => {
        const who = p.id === 'auto-review' ? reviewer : 'user';
        const allowed = profiles.data.some(item => item.id === p.profile && item.allowed === true) &&
          (requirements.allowedPermissionProfiles == null || requirements.allowedPermissionProfiles.includes(p.profile)) &&
          (requirements.allowedApprovalPolicies == null || requirements.allowedApprovalPolicies.includes(p.policy)) &&
          (reviewers == null || reviewers.includes(who)) &&
          !(p.id === 'auto-review' && (config.features?.guardian_approval === false || config['features.guardian_approval'] === false));
        return { id:p.id, label:p.label, description:p.description, enabled:allowed, disabledReason:allowed ? '' : '电脑配置或托管策略不允许此权限' };
      });
      return { config, options, reviewer };
    });
  }
  async read(cwd) {
    const { config, options } = await this.capabilities(cwd);
    const profile = { 'workspace-write':':workspace', 'read-only':':read-only', 'danger-full-access':':danger-full-access' }[config.sandbox_mode];
    const current=permissionState({latestThreadSettings:{ permissions:profile, approvalPolicy:config.approval_policy, approvalsReviewer:config.approvals_reviewer }});
    if(config.sandbox_workspace_write?.network_access === true || config.sandbox_workspace_write?.writable_roots?.length > 0 || (config.permissions != null && config.permissions !== profile)) current.mode='custom';
    return { ...current, options };
  }
}

/** 刷新已有订阅；读取能力期间切换所有者或权限会使整个结果失效。 */
export async function readPermissions(adapter,threadId,deviceId) {
  adapter.subscribed(threadId,deviceId);
  await adapter.watch(threadId,deviceId,{fresh:true,history:false});
  const entry=adapter.subscribed(threadId,deviceId), owner=entry.owner, current=permissionState(entry.state);
  const catalog=adapter.permissionCatalog ??= new PermissionCatalog();
  let capabilities;
  try { capabilities=await catalog.capabilities(entry.state.cwd ?? entry.state.environments?.[0]?.cwd); }
  catch { throw new BridgeError('PERMISSIONS_UNAVAILABLE','无法读取电脑权限能力，请确认连接后重新读取'); }
  if(adapter.subscribed(threadId,deviceId)!==entry || entry.owner!==owner || permissionState(entry.state).revision!==current.revision) throw new BridgeError('PERMISSIONS_CHANGED','电脑权限已变化，请重新读取');
  return { ...current, options:capabilities.options, reviewer:capabilities.reviewer };
}

/** 只提交固定内置档案；沙箱与审查始终由原桌面落实，成功后必须回读。 */
export async function updatePermissions(adapter,params,commandId,deviceId,checkpoint=()=>{}) {
  const current=await readPermissions(adapter,params.threadId,deviceId);
  if(current.revision!==params.expectedRevision) throw new BridgeError('PERMISSIONS_CHANGED','电脑权限已变化，请重新选择');
  const preset=presets.find(p=>p.id===params.mode);
  if(!preset || !current.options.some(p=>p.id===params.mode&&p.enabled)) throw new BridgeError('PERMISSION_NOT_ALLOWED','电脑不允许所选权限');
  if(params.mode==='full-access'&&params.confirmedFullAccess!==true) throw new BridgeError('PERMISSION_CONFIRMATION_REQUIRED','请先确认电脑完整访问权限');
  const entry=adapter.subscribed(params.threadId,deviceId), owner=entry.owner;
  const threadSettings={ permissions:preset.profile, approvalPolicy:preset.policy, approvalsReviewer:params.mode==='auto-review'?current.reviewer:'user' };
  const snapshot=adapter.snapshot(entry.state), activeTurnId=snapshot.activeTurnId;
  checkpoint({ permissionChange: { ...params } });
  let response;
  try { response=await adapter.client.request('thread-follower-update-thread-settings',{conversationId:params.threadId,threadSettings,...(activeTurnId?{activeTurnId}:{})},2,{targetClientId:owner.clientId,timeoutMs:15000}); }
  catch { throw new BridgeError('OUTCOME_UNKNOWN','权限切换结果未知，请先核对电脑端',true); }
  if(response.resultType!=='success'||response.result?.applied!==true) throw new BridgeError('PERMISSIONS_REJECTED','电脑未接受权限切换，请重新读取');
  // 原生更新会先广播选择，再广播落实后的沙箱；仅重取快照，不重发写请求。
  for(let attempt=0;attempt<5;attempt++) {
    try {
      const confirmed=await readPermissions(adapter,params.threadId,deviceId);
      const nextOwner=adapter.subscribed(params.threadId,deviceId).owner;
      if(nextOwner?.clientId!==owner.clientId || nextOwner?.hostId!==owner.hostId) break;
      if(confirmed.mode===params.mode) return {ok:true,commandId,...confirmed};
    } catch(error) { if(error.code!=='PERMISSIONS_CHANGED') break; }
    if(attempt<4) await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new BridgeError('OUTCOME_UNKNOWN','权限已提交但尚未确认，请先核对电脑端',true);
}

/** 未知结果只读核对已记录的原始选择，指纹与订阅必须同时匹配。 */
export async function permissionCommandStatus(adapter,journal,deviceId,commandId) {
  const original=journal.status(deviceId,commandId), params=original.result?.permissionChange;
  if(original.state!=='unknown'||!params||typeof journal.unknownFingerprint!=='function') return original;
  const fingerprint=journal.unknownFingerprint(deviceId,commandId);
  if(!fingerprint||fingerprint!==requestFingerprint('thread.permissions.update',params)) return original;
  try {
    const current=await adapter.readPermissions(params.threadId,deviceId);
    if(current.mode!==params.mode) return original;
    return journal.confirmObservedPermission(deviceId,commandId,fingerprint,{ok:true,commandId,...current,reconciled:true});
  } catch { return original; }
}
