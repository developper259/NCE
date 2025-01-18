class Javascript extends LanguageController {
    constructor(e) {
        super(e);

        this.name = 'Javascript';
        this.extension = 'js';
        this.icon = 'Javascript';
        this.data = {
            variable: this.detectVariable.bind(this),
            function: this.detectFunction.bind(this),
            string: this.detectString.bind(this),
            keyword: ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return', 'new', 'import', 'export', 'default', 'await', 'yield'],
            specialKeyword: ['var', 'let', 'const', 'function', 'this', 'true', 'false', 'undefined', 'null', 'NaN', 'typeof', 'instanceof', 'typeof', 'void', 'delete', 'in', 'typeof', 'async', 'class', 'extends', 'super', 'constructor'],
            specialLetter: ['{', '}', '(', ')', '[', ']'],
            separator: ['.', ',', ';', ':', '='],
            comment: this.detectComment.bind(this),
            number: this.detectNumber.bind(this),
            error: this.detectError.bind(this),
        };
        
    }

    detectVariable(words, index) {
        const maps = ['const', 'let', 'var'];
        let response = {value: false, params: {}};
        const word = words[index];
        const nextWord = words[index + 1];
        const oldWord = words[index - 1];
        
        if (maps.includes(oldWord)) response.value = true;
        if (index > 1 && oldWord === '.' || nextWord === '.') response.value = true;
        if (this.data.specialKeyword.includes(word) || this.data.specialLetter.includes(word) || this.data.keyword.includes(word) || nextWord != '(') response.value = false;
        
        return response;
    }
    detectFunction(words, index) {
        let response = {value: false, params: {}};
        const word = words[index];
        const nextWord = words[index + 1];

        if (index != words.length - 1 && nextWord === '(') response.value = true;
        if (this.data.specialKeyword.includes(word) || this.data.specialLetter.includes(word) || this.data.keyword.includes(word)) response.value = false;

        return response;
    }
    detectString(words, index, params) {
        const s = ['"', "'", '`'];
        let oldS = params.oldS;
        let word = words[index];
        let oldWord = words[index - 1];

        let response = {value: false, params: {}};

        if (s.includes(words[index])) response.value = true;

        if (s.includes(word)) {
            if (!oldS) oldS = word;
            else if (oldS && word == oldS && oldWord[oldWord.length - 1] != '\\') oldS = undefined;
        } 

        if (oldS) response.value = true;

        response.params.oldS = oldS;

        return response;
    }
    detectNumber(words, index) {
        const n = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
        let response = {value: true, params: {}};

        const word = words[index];
        
        for (let c of word) {
            if (!n.includes(c)) {
                response.value = false;
                break;
            }
        }
        
        return response;
    }
    detectComment(words, index, params) {
        let inLine = params.inLine;
        let inFull = params.inFull;
        const word = words[index];
        const nextWord = words[index + 1];
        const oldWord = words[index - 1];
        let response = {value: false, params: {}};

        if (words.length > 1 && word == '/') {
            console.log(oldWord);
            if (oldWord == '*') {
                inFull = false;
                response.value = true;
            } else if (!inFull && nextWord == '/') inLine = true;
            else if (!inFull && nextWord == '*') inFull = true;
        }
        if (inLine || inFull) response.value = true;

        response.params.inLine = inLine;
        response.params.inFull = inFull;

        return response;
    }
    detectError(words, index, params) {}
}