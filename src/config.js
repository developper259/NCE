const USERCONFIG_KEYBINDING = [
    {
        "action": "save",
        "description": "Sauvegarder le fichier actuel",
        "key": "Meta+S",
        "in_editor": false
    },
    {
        "action": "open_file",
        "description": "Ouvrir un fichier",
        "key": "Meta+O",
        "in_editor": false
    },
    {
        "action": "new_file",
        "description": "Créer un nouveau fichier",
        "key": "Meta+N",
        "in_editor": false
    },
    {
        "action": "close_file",
        "description": "Fermer le fichier actuel",
        "key": "Meta+W",
        "in_editor": true
    },
    {
        "action": "copy",
        "description": "Copier la sélection",
        "key": "Meta+C",
        "in_editor": true
    },
    {
        "action": "paste",
        "description": "Coller le contenu",
        "key": "Meta+V",
        "in_editor": true
    },
    {
        "action": "cut",
        "description": "Couper la sélection",
        "key": "Meta+X",
        "in_editor": true
    },
    {
        "action": "undo",
        "description": "Annuler la dernière action",
        "key": "Meta+Z",
        "in_editor": true
    },
    {
        "action": "redo",
        "description": "Rétablir la dernière action",
        "key": "Meta+Y",
        "in_editor": true
    },
    {
        "action": "find",
        "description": "Rechercher dans le fichier",
        "key": "Meta+F",
        "in_editor": true
    },
    {
        "action": "replace",
        "description": "Remplacer dans le fichier",
        "key": "Meta+H",
        "in_editor": true
    },
    {
        "action": "open_command",
        "description": "Ouvrir le panel de commande",
        "key": "Meta+P",
        "in_editor": false
    },
    {
        "action": "delete_line",
        "description": "Supprimer la ligne actuelle",
        "key": "Meta+Shift+K",
        "in_editor": true
    },
    {
        "action": "select_all",
        "description": "Sélectionner tout",
        "key": "Meta+A",
        "in_editor": true
    },
    {
        "key": "Escape",
        "action": "escape",
        "in_editor": false
    },
    {
        "key": "Tab",
        "action": "indent_right",
        "in_editor": true
    },
    {
        "key": "Delete",
        "action": "delete_right",
        "in_editor": true
    },
    {
        "key": "Backspace",
        "action": "delete_left",
        "in_editor": true
    },
    {
        "key": "Enter",
        "action": "newline",
        "in_editor": true
    },
    {
        "key": "ArrowUp",
        "action": "move_up",
        "in_editor": false
    },
    {
        "key": "ArrowDown",
        "action": "move_down",
        "in_editor": false
    },
    {
        "key": "ArrowLeft",
        "action": "move_left",
        "in_editor": false
    },
    {
        "key": "ArrowRight",
        "action": "move_right",
        "in_editor": false
    },
    {
        "key": "Home",
        "action": "move_to_line_start",
        "in_editor": true
    },
    {
        "key": "End",
        "action": "move_to_line_end",
        "in_editor": true
    },
    {
        "key": "Insert",
        "action": "toggle_insert_mode",
        "in_editor": true
    }
];

USERCONFIG_CONFIG = {
    "tab_width": 4
};



function CONFIG_KEYBINDING_CONTAINSKEY(key) {
    if (CONFIG_KEYBINDING_GET_KEY(key)) return true;
    return false;
}

function CONFIG_KEYBINDING_CONTAINSACTIN(action) {
    if (CONFIG_KEYBINDING_GET_ACTION(action)) return true;
    return false;
}

function CONFIG_KEYBINDING_GET_KEY(key) {
    for (item of USERCONFIG_KEYBINDING) {
        if (item.key.toLowerCase() == key.toLowerCase()) return item;
    } 
}

function CONFIG_KEYBINDING_GET_ACTION(action) {
    for (item of USERCONFIG_KEYBINDING) {
        if (item.action.toLowerCase() == action.toLowerCase()) return item;  
    }
}

function CONFIG_GET(key) {
    return USERCONFIG_CONFIG[key];
}

function CONFIG_SET(key, val) {
    USERCONFIG_CONFIG[key] = val;
}