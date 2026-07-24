export const frontendHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Infinity Agents Edge</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #0b0d10; color: #f2f4f7; }
      main { width: min(880px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
      header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
      h1 { margin: 0; font-size: clamp(1.65rem, 4vw, 2.4rem); letter-spacing: -.04em; }
      .tag { color: #98a2b3; font-size: .9rem; }
      .panel { border: 1px solid #252a33; border-radius: 16px; padding: 20px; background: #11141a; box-shadow: 0 16px 45px #0005; }
      label { display: block; color: #c6ccd7; font-size: .85rem; margin: 0 0 8px; }
      input, textarea, button { font: inherit; }
      input, textarea { width: 100%; border: 1px solid #343b47; border-radius: 10px; background: #0b0d10; color: inherit; padding: 12px; outline: none; }
      input:focus, textarea:focus { border-color: #90e56a; box-shadow: 0 0 0 3px #90e56a22; }
      textarea { min-height: 132px; resize: vertical; }
      .token { margin-bottom: 18px; }
      .send-row { display: flex; justify-content: flex-end; margin-top: 12px; }
      button { border: 0; border-radius: 10px; padding: 10px 16px; background: #90e56a; color: #10230a; font-weight: 700; cursor: pointer; }
      button:disabled { opacity: .55; cursor: wait; }
      .output { min-height: 180px; margin: 20px 0 0; padding: 16px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; border-radius: 10px; background: #080a0d; color: #e5e7eb; }
      .status { color: #98a2b3; font-size: .85rem; margin-top: 12px; min-height: 1.25em; }
      .hint { color: #98a2b3; font-size: .8rem; line-height: 1.5; margin: 20px 2px 0; }
      code { color: #b4f59a; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Infinity Agents Edge</h1>
        <span class="tag">StepFun Coding Plan</span>
      </header>
      <section class="panel">
        <div class="token">
          <label for="token">访问令牌</label>
          <input id="token" type="password" autocomplete="off" placeholder="粘贴 CLIENT_API_KEY" />
        </div>
        <label for="prompt">消息</label>
        <textarea id="prompt" placeholder="输入你的问题…"></textarea>
        <div class="send-row"><button id="send">发送</button></div>
        <div id="status" class="status">等待输入</div>
        <pre id="output" class="output"></pre>
      </section>
      <p class="hint">令牌只保存在当前浏览器的 localStorage 中，并在请求时通过 <code>Authorization</code> 发送。该页面不会保存对话记录。</p>
    </main>
    <script>
      const token = document.querySelector('#token');
      const prompt = document.querySelector('#prompt');
      const send = document.querySelector('#send');
      const output = document.querySelector('#output');
      const status = document.querySelector('#status');
      const tokenKey = 'infinity-agents-edge-client-key';
      token.value = localStorage.getItem(tokenKey) || '';
      token.addEventListener('change', () => localStorage.setItem(tokenKey, token.value.trim()));

      function appendEvent(raw) {
        if (!raw.startsWith('data:')) return;
        const data = raw.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const event = JSON.parse(data);
        const delta = event.choices && event.choices[0] && event.choices[0].delta;
        if (!delta) return;
        if (delta.content) output.textContent += delta.content;
      }

      send.addEventListener('click', async () => {
        const key = token.value.trim();
        const content = prompt.value.trim();
        if (!key || !content) { status.textContent = '请填写访问令牌和消息。'; return; }
        localStorage.setItem(tokenKey, key);
        send.disabled = true;
        output.textContent = '';
        status.textContent = '模型正在响应…';
        try {
          const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content }], stream: true })
          });
          if (!response.ok || !response.body) throw new Error(await response.text());
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const events = buffer.split('\\n\\n');
            buffer = events.pop() || '';
            events.forEach(appendEvent);
            if (done) break;
          }
          status.textContent = '完成';
        } catch (error) {
          status.textContent = '请求失败：' + (error && error.message ? error.message : String(error));
        } finally {
          send.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
