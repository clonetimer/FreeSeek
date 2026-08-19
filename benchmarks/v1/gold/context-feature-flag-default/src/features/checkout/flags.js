const DEFAULTS={newCheckout:false,expressPay:false};
exports.resolveFlags=(env={})=>({...DEFAULTS,...env});
