document.querySelector('#login').addEventListener('submit', async event => {
  event.preventDefault();
  const output = document.querySelector('#status');
  try {
    const response = await fetch('/api/status', { headers: { Authorization: `Bearer ${document.querySelector('#token').value}` } });
    if (!response.ok) throw new Error(`请求失败：${response.status}`);
    output.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (error) { output.textContent = error.message; }
});
