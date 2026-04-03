const TranslationManager = (function () {
    let currentLang = localStorage.getItem('language') || 'it';

    function t(key, params = {}) {
        const langDict = TRANSLATIONS[currentLang] || TRANSLATIONS['it'];
        let text = langDict[key] || key;

        for (const [k, v] of Object.entries(params)) {
            text = text.replace(`{${k}}`, v);
        }
        return text;
    }

    function updateDOM() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (key) {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.placeholder = t(key);
                } else {
                    const icon = el.querySelector('.btn-icon');
                    if (icon) {
                        const iconHTML = icon.outerHTML;
                        const translatedText = t(key);
                        el.innerHTML = iconHTML + ' ' + translatedText;
                    } else {
                        el.textContent = t(key);
                    }
                }
            }
        });
        document.documentElement.lang = currentLang;
    }

    function setLanguage(lang) {
        if (TRANSLATIONS[lang]) {
            currentLang = lang;
            localStorage.setItem('language', lang);
            updateDOM();
        }
    }

    function getLanguage() {
        return currentLang;
    }

    return {
        t,
        updateDOM,
        setLanguage,
        getLanguage
    };
})();

document.addEventListener('DOMContentLoaded', () => {
    TranslationManager.updateDOM();

    const langSelect = document.getElementById('languageSelect');
    if (langSelect) {
        langSelect.value = TranslationManager.getLanguage();
        langSelect.addEventListener('change', (e) => {
            TranslationManager.setLanguage(e.target.value);
            // Reload to ensure socket re-connects with correct language or other init logic
            window.location.reload();
        });
    }
});
