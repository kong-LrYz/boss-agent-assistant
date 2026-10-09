const status = document.getElementById('status');
const form = document.getElementById('pair');
const button = form.querySelector('button');
const base = document.getElementById('base');
const initialBase = base.value;
let pairingAttempted = false;
form.onsubmit = async event => {
  event.preventDefault();
  if (button.disabled) return;
  pairingAttempted = true;
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BOSS_PAIR', base: base.value.trim(), code: document.getElementById('code').value.trim() });
    if (!response?.ok) throw Error(response?.error || '连接失败');
    document.getElementById('code').value = ''; status.textContent = '配对成功。返回本地控制台即可开始投递。';
  } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
};
// Enable the form only after its handler exists; never native-submit a code.
button.disabled = false;
try {
  const state = await chrome.runtime.sendMessage({ type: 'BOSS_BRIDGE_STATUS' });
  if (!pairingAttempted) {
    if (state?.paired) {
      if (base.value === initialBase) base.value = state.base;
      status.textContent = '已配对。返回本地控制台即可开始投递。';
    } else status.textContent = '尚未配对，请填写本地控制台给出的配对码。';
  }
} catch (error) {
  if (!pairingAttempted) status.textContent = `读取连接状态失败：${error.message}`;
}
