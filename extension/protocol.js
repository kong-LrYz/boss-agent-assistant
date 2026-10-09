export const VERSION = 1;
export const OPS = Object.freeze([
  'OPEN_SESSION', 'STOP_SESSION', 'READ_STATUS', 'INSPECT_PAGE', 'NAV_SEARCH', 'NAV_JOB', 'NEXT_PAGE',
  'READ_CARDS', 'READ_DETAIL', 'READ_CONVERSATION', 'READ_RESUME', 'READ_CONTACT_CONFIRMATION', 'READ_CONVERSATION_VERIFICATION',
  'OPEN_CONTACT', 'FILL_GREETING', 'SEND_GREETING', 'REQUEST_RESUME', 'SELECT_RESUME', 'CONFIRM_RESUME', 'DISMISS_CONTACT_CONFIRMATION', 'VERIFY_CONVERSATION_JOB'
]);
export const EFFECT_OPS = Object.freeze([
  'OPEN_SESSION', 'NAV_SEARCH', 'NAV_JOB', 'NEXT_PAGE', 'OPEN_CONTACT',
  'FILL_GREETING', 'SEND_GREETING', 'REQUEST_RESUME', 'SELECT_RESUME', 'CONFIRM_RESUME', 'DISMISS_CONTACT_CONFIRMATION', 'VERIFY_CONVERSATION_JOB'
]);
export const SEND_OPS = Object.freeze(['OPEN_CONTACT', 'SEND_GREETING', 'REQUEST_RESUME', 'CONFIRM_RESUME']);

export function bossUrl(value) {
  const url = new URL(value);
  if(url.protocol!=='https:' || url.hostname!=='www.zhipin.com' || url.username || url.password)throw Error('只允许官方 BOSS 网页');
  return url;
}
export function jobUrl(value) {
  const url=bossUrl(value);
  if(!/^\/job_detail\/[A-Za-z0-9_-]+\.html$/u.test(url.pathname))throw Error('岗位地址不可确认');
  return url.origin+url.pathname;
}
export function localBase(value) {
  const url=new URL(value);
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw Error('仅支持本机 127.0.0.1 控制台地址');
  return url.origin;
}
