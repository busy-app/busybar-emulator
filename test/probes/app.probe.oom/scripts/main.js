// Runs for a second, then keeps everything it allocates until the heap is full.
var kept = [];
setTimeout(function () {
  for (;;) kept.push("0123456789abcdef" + kept.length);
}, 1000);
