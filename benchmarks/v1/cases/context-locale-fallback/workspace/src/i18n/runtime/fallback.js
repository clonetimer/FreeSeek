exports.fallbackChain=function(locale){
  const [lang,region]=locale.split('-');
  return region ? [locale,lang,'en'] : [locale,'en'];
};
