const fs = require('fs');
const path = require('path');
const dir = './src/db/models/core';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
for (const file of files) {
  let content = fs.readFileSync(path.join(dir, file), 'utf8');
  content = content.replace(/from\s+['"](\.\/[^'"]+)['"]/g, (match, p1) => {
    if (!p1.endsWith('.js')) return `from '${p1}.js'`;
    return match;
  });
  fs.writeFileSync(path.join(dir, file), content);
}
console.log('Fixed imports in models');
