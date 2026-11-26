// 翻译目标语言列表: panel 与首选项共用.
// label 用该语言的自称, 不参与翻译.
export const TARGET_LANGUAGES = [
    {id: 'zh-CN', label: '简体中文'},
    {id: 'zh-TW', label: '繁體中文'},
    {id: 'en', label: 'English'},
    {id: 'ja', label: '日本語'},
    {id: 'ko', label: '한국어'},
    {id: 'fr', label: 'Français'},
    {id: 'de', label: 'Deutsch'},
    {id: 'es', label: 'Español'},
    {id: 'ru', label: 'Русский'},
    {id: 'pt', label: 'Português'},
    {id: 'it', label: 'Italiano'},
    {id: 'ar', label: 'العربية'},
];

export function languageLabel(id) {
    return TARGET_LANGUAGES.find(lang => lang.id === id)?.label ?? id;
}
