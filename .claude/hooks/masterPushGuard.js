// Hook PreToolUse (Bash / PowerShell): solo la sesión coordinadora puede hacer push a master.
// Cualquier otra sesión de Claude Code recibe un "deny" y tiene que pedirle el merge a esa sesión.
// La sesión permitida se configura con MASTER_PUSH_SESSION (ver .claude/settings.local.json).

const SESION_PERMITIDA = process.env.MASTER_PUSH_SESSION || '';

let entrada = '';
process.stdin.on('data', c => { entrada += c; });
process.stdin.on('end', () => {
    let datos;
    try { datos = JSON.parse(entrada.replace(/^﻿/, '')); } catch { return; }

    const comando = String((datos.tool_input && datos.tool_input.command) || '');
    if (!/\bgit\b[^\n;|&]*\bpush\b/.test(comando)) return;

    // Push a master: refspec explícito, --all/--mirror, o push sin refspec (puede salir de master)
    const pushes = comando.match(/\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*/g) || [];
    const tocaMaster = pushes.some(p => {
        if (/(^|[\s:+])(refs\/heads\/)?master(?=\s|$)/.test(p.split(/\bpush\b/)[1] || '')) return true;
        if (/\s--(all|mirror)\b/.test(p)) return true;
        const args = (p.split(/\bpush\b/)[1] || '').trim().split(/\s+/).filter(a => a && !a.startsWith('-'));
        return args.length <= 1; // "git push" o "git push origin" sin rama
    });
    if (!tocaMaster) return;

    const permitido = Boolean(SESION_PERMITIDA) && datos.session_id === SESION_PERMITIDA;

    // Registro de auditoría: quién intentó pushear a master y qué se decidió
    try {
        require('fs').appendFileSync(
            require('path').join(__dirname, 'master-push.log'),
            `${new Date().toISOString()} ${permitido ? 'allow' : 'deny '} ${datos.session_id} ${comando.replace(/\s+/g, ' ')}\n`
        );
    } catch { /* el log no debe frenar la decisión */ }

    if (permitido) {
        console.log(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                permissionDecisionReason: '✅ Sesión coordinadora: push a master permitido',
            },
        }));
        return;
    }

    console.log(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                '❌ Solo la sesión coordinadora de ramas (neggo-app-73) puede hacer push a master. ' +
                'Pusheá tu rama (git push origin <tu-rama>, con el nombre explícito) y pedile el merge a esa sesión con SendMessage.',
        },
    }));
});
