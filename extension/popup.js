const status = document.getElementById('status');
const state = await chrome.runtime.sendMessage({ type: 'BOSS_BRIDGE_STATUS' });
if (state?.paired) { document.getElementById('base').value = state.base; status.textContent = '已配对。保持本地控制台开启后，可先预览岗位。'; }
else status.textContent = '尚未配对，请填写本地控制台给出的配对码。';
document.getElementById('pair').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BOSS_PAIR', base: document.getElementById('base').value.trim(), code: document.getElementById('code').value.trim() });
    if (!response?.ok) throw Error(response?.error || '连接失败');
    document.getElementById('code').value = ''; status.textContent = '配对成功。返回本地控制台，先预览岗位。';
  } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
};
