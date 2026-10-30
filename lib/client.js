/* Desktop navigation companion; no UI overlays and no changes to approvals. */
window.__ModuleLoader__.load({
  id: 'dsh-island-bridge',
  factory: function () {
    return {
      inject: ['uiWorkspace'],
      apply: function (ctx) {
        if (window.location.protocol !== 'dsh-app:') return;
        ctx.effect(function () {
          var controller = new AbortController();
          var lastOpened = null;
          var workspace = ctx.get('uiWorkspace');
          async function run() {
            while (!controller.signal.aborted) {
              try {
                var response = await fetch('/api/island-navigation/wait', {
                  signal: controller.signal, credentials: 'same-origin', cache: 'no-store'
                });
                if (!response.ok) throw new Error('navigation HTTP ' + response.status);
                var data = await response.json();
                var command = data && data.open;
                if (!command) continue;
                var result = { id: command.id, sessionId: command.sessionId, ok: false };
                try {
                  if (lastOpened !== command.id) {
                    await Promise.resolve(workspace.openSession(command.sessionId));
                    var selected = workspace.selection && workspace.selection.getSnapshot();
                    if (selected && selected.sessionId !== command.sessionId) throw new Error('session was not selected');
                    lastOpened = command.id;
                  }
                  result.ok = true;
                } catch (error) { result.reason = String(error); }
                var ack = await fetch('/api/island-navigation/ack', {
                  method: 'POST', signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
                  headers: { 'content-type':'application/json' }, body: JSON.stringify(result)
                });
                if (!ack.ok) throw new Error('navigation acknowledgement HTTP ' + ack.status);
                if (!result.ok) console.warn('[island-bridge] could not open conversation:', result.reason);
              } catch (error) {
                if (controller.signal.aborted) break;
                console.warn('[island-bridge] navigation reconnect:', String(error));
                await new Promise(function (resolve) {
                  var done = function () { clearTimeout(timer); controller.signal.removeEventListener('abort',done); resolve(); };
                  var timer = setTimeout(done,1000);
                  controller.signal.addEventListener('abort',done,{once:true});
                });
              }
            }
          }
          void run();
          return function () { controller.abort(); };
        }, 'island-bridge: desktop conversation navigation');
      }
    };
  }
});
