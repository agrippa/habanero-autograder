var bcrypt = require('bcrypt-nodejs');
var password = process.argv[2];
var passwordHash = bcrypt.hashSync(password);
console.log(passwordHash);
