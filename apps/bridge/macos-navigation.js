ObjC.import('Foundation');

/** 只向已核验的进程投递固定聊天链接，不交给 LaunchServices 选择任意实例。 */
function run(argv) {
  const pid = Number(argv[0]), threadId = argv[1];
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId ?? '')) throw Error('实例导航参数无效');
  const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);
  const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x4755524c, 0x4755524c, target, -1, 0);
  event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString('codex://threads/' + threadId), 0x2d2d2d2d);
  const error = Ref();
  const response = event.sendEventWithOptionsTimeoutError(3, 5, error);
  if (!error[0].isNil() || response.isNil() || response.paramDescriptorForKeyword(0x6572726e).int32Value !== 0) throw Error('Mac 实例未确认导航');
  return '实例导航已投递';
}
