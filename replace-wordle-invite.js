const fs = require('fs');
const p = 'modes/wordlechain/client.js';
let content = fs.readFileSync(p, 'utf8');

const search = 'function shareInviteLink() {\r\n    if (!myRoomCode) return;\r\n    const url = `${window.location.origin}${window.location.pathname}?join=${myRoomCode}`;\r\n    const text = `Join my WordleChain battle! Room: ${myRoomCode}`;\r\n\r\n    if (navigator.share) {\r\n        navigator.share({ title: \'WordleChain\', text, url }).catch(() => {});\r\n    } else {\r\n        navigator.clipboard.writeText(url).then(() => {\r\n            showToast(\'📋 Link copiato!\', \'success\');\r\n        }).catch(() => {\r\n            prompt(\'Copy this link:\', url);\r\n        });\r\n    }\r\n}';

const searchLF = search.replace(/\r\n/g, '\n');

const replace = `function shareInviteLink() {
    if (!myRoomCode) return;
    const url = \`\${window.location.origin}\${window.location.pathname}?join=\${myRoomCode}\`;
    const text = \`Join my WordleChain battle! Room: \${myRoomCode}\`;

    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: 'WordleChain', text, url }).catch(() => {});
    } else {
        let container = document.getElementById('invite-link-display');
        if (!container) {
            container = document.createElement('div');
            container.id = 'invite-link-display';
            container.style.marginTop = '15px';
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.justifyContent = 'center';
            container.style.gap = '10px';
            container.style.background = 'rgba(0,0,0,0.3)';
            container.style.padding = '10px';
            container.style.borderRadius = '8px';
            container.style.border = '1px solid rgba(255,255,255,0.2)';
            container.style.width = '100%';
            container.style.maxWidth = '400px';

            const input = document.createElement('input');
            input.type = 'text';
            input.readOnly = true;
            input.value = url;
            input.style.flex = '1';
            input.style.background = 'transparent';
            input.style.border = 'none';
            input.style.color = '#ffd200';
            input.style.fontSize = '0.9rem';
            input.style.outline = 'none';
            input.style.textAlign = 'center';
            input.onclick = () => input.select();

            const copyBtn = document.createElement('button');
            copyBtn.textContent = '📋 Copia';
            copyBtn.style.margin = '0';
            copyBtn.style.padding = '6px 12px';
            copyBtn.style.fontSize = '0.9rem';
            copyBtn.style.background = '#444';
            copyBtn.style.border = 'none';
            copyBtn.style.borderRadius = '6px';
            copyBtn.style.color = '#fff';
            copyBtn.style.cursor = 'pointer';

            copyBtn.onclick = () => {
                navigator.clipboard.writeText(url).then(() => {
                    showToast('📋 Link copiato!', 'success');
                });
            };

            container.appendChild(input);
            container.appendChild(copyBtn);

            const shareBtn = document.getElementById('share-invite-btn');
            if (shareBtn && shareBtn.parentNode) {
                shareBtn.parentNode.insertBefore(container, shareBtn.nextSibling);
            }
        } else {
            const inp = container.querySelector('input');
            if (inp) {
                inp.value = url;
                inp.select();
            }
        }

        navigator.clipboard.writeText(url).then(() => {
            showToast('📋 Link copiato!', 'success');
        }).catch(() => {});
    }
}`;

if (content.includes(search)) {
    fs.writeFileSync(p, content.replace(search, replace), 'utf8');
    console.log('Success CRLF');
} else if (content.includes(searchLF)) {
    fs.writeFileSync(p, content.replace(searchLF, replace), 'utf8');
    console.log('Success LF');
} else {
    // Try regex replace
    const regex = /function shareInviteLink\(\) \{[\s\S]*?prompt[\s\S]*?\n\}/;
    if (regex.test(content)) {
        fs.writeFileSync(p, content.replace(regex, replace), 'utf8');
        console.log('Success regex');
    } else {
        console.log('Not found');
    }
}
