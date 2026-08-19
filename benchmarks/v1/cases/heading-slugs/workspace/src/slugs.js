exports.createSlugger = function createSlugger() {
  return (heading) => heading.toLowerCase().replace(/\s+/g,"-");
};
