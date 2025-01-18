class PlainText extends LanguageController {
  constructor(e) {
    super(e);
    
    this.name = 'Plain Text';
    this.extension = 'txt';
    this.icon = 'code';

    this.data = {
        variable: null,
        function: null,
        string: null,
        keyword: null,
        specialLetter: null,
        separator: null,
        comment: null,
        number: null,
        error: null,
    };
  }
}