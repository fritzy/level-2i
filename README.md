#Level-2i, Secondary Indexes for Level

Creates and manages indexes and totals for your keys atomically, allowing you to look up keys by their secondary indexes.
Indexes are kept up to date as you update the value.

## Wrap LevelUp

```javascript
var Level2i = require('level2i');
var mydb = Level2i(levelup('/some/path'));
```

## Put with indexes

```javascript
mydb.put('somekey', 'cheese', {indexes: {'name_bin': 'Fritzy'}}, function (err) {
    // ...
});
```

## Look up indexed values

```javascript
var fritzyresults = mydb.createReadStream({index: 'name_bin', start: 'fritzy', end: 'fritzy'});
```

## Find out how many indexed values you have

```
mydb.getIndexValueTotal('name_bin', 'fritzy', function (err, total) {
    console.log("There are %d fritzys!" % total);
});
```

## Kept up to date!

* Every put replaces the indexes with what you specify
* Deleting a key removes it from the results
* Counts are kept accurate
