const fs = require('fs');

exports.loadSales = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((line) => {
  const [region, units, price] = line.split(',');
  return { region, units: Number(units), price: Number(price) };
});
