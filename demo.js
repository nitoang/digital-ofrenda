// Both altars share the id "demo"; keep the view copy in sync when the editor saves.
const [editor, viewer] = document.querySelectorAll('digital-ofrenda');
editor.addEventListener('ofrenda-change', () => viewer.importState(editor.exportState()));
