'use strict';

// The shared server derives a fixed 3014 launch profile from this entrypoint name.
// No environment variable can redirect this instance to the 3013 port or data store.
require('./server');
