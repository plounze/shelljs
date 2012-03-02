//
// shell.js
// Unix shell commands on top of Node's API
//
// Copyright (c) 2012 Artur Adib
// http://github.com/arturadib/shell.js
//

var fs = require('fs'),
    path = require('path'),
    util = require('util'),
    vm = require('vm'),
    child = require('child_process'),
    os = require('os');

// Node shims for < v0.7
fs.existsSync = fs.existsSync || path.existsSync;

var state = {
      error: null,
      fatal: false,
      silent: false,
      currentCmd: 'shell.js',
      tempDir: null
    },
    platform = os.type().match(/^Win/) ? 'win' : 'unix';


//@
//@ #### echo('message' [,'message' ...])
exports.echo = wrap('echo', function() {
  console.log.apply(this, arguments);
});

//@
//@ #### ls([options] [,path ,path ...])
//@ Available options:
//@
//@ + `-R`: recursive
//@ + `-a`: all files (include files beginning with `.`)
//@
//@ Examples:
//@
//@ + `ls('projs/*.js')`
//@ + `ls('-R', '/users/me', '/tmp')`
//@ + `ls('-a', ['dir1/', 'dir2/'])`
//@
//@ Returns list of files in the given path, or in current directory if no path provided.
//@ For convenient iteration via `for (file in ls())`, the format returned is a hash object:
//@ `{ 'file1':null, 'dir1/file2':null, ...}`.
function _ls(options, paths) {
  options = parseOptions(options, {
    'R': 'recursive',
    'a': 'all'
  });

  if (!paths)
    paths = ['.'];
  else if (typeof paths === 'object')
    paths = paths; // assume array
  else if (typeof paths === 'string')
    paths = [].slice.call(arguments, 1);

  var hash = {};

  function pushHash(file, query) {
    // hidden file?
    if (path.basename(file)[0] === '.') {
      // not explicitly asking for hidden files?
      if (!options.all && !(path.basename(query)[0] === '.' && path.basename(query).length > 1))
        return;
    }

    hash[file] = null;
  }

  paths.forEach(function(p) {
    if (fs.existsSync(p)) {
      // Simple file?
      if (fs.statSync(p).isFile()) {
        pushHash(p, p);
        return; // continue
      }
      
      // Simple dir?
      if (fs.statSync(p).isDirectory()) {
        // Iterate over p contents
        fs.readdirSync(p).forEach(function(file) {
          pushHash(file, p);

          // Recursive
          var oldDir = _pwd();
          _cd('', p);
          if (fs.statSync(file).isDirectory() && options.recursive)
            hash = extend(hash, _ls('-R', file+'/*'));
          _cd('', oldDir);
        });
        return; // continue
      }
    }

    // p does not exist - possible wildcard present

    var basename = path.basename(p);
    var dirname = path.dirname(p);
    // Wildcard present on an existing dir? (e.g. '/tmp/*.js')
    if (basename.search(/\*/) > -1 && fs.existsSync(dirname) && fs.statSync(dirname).isDirectory) {
      // Escape special regular expression chars
      var regexp = basename.replace(/(\^|\$|\(|\)|\<|\>|\[|\]|\{|\}|\.|\+|\?)/g, '\\$1');
      // Translates wildcard into regex
      regexp = '^' + regexp.replace(/\*/g, '.*');
      // Iterate over directory contents
      fs.readdirSync(dirname).forEach(function(file) {
        if (file.match(new RegExp(regexp))) {
          pushHash(path.normalize(dirname+'/'+file), basename);

          // Recursive
          var pp = dirname + '/' + file;
          if (fs.statSync(pp).isDirectory() && options.recursive)
            hash = extend(hash, _ls('-R', pp+'/*'));
        }
      }); // forEach
      return;
    }

    error('no such file or directory: ' + p, true);
  });

  return hash;
};
exports.ls = wrap('ls', _ls);

//@
//@ #### cd('dir')
//@ Changes to directory `dir` for the duration of the script
function _cd(options, dir) {
  if (!dir)
    error('directory not specified');

  if (!fs.existsSync(dir))
    error('no such file or directory: ' + dir);

  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory())
    error('not a directory: ' + dir);

  process.chdir(dir);
};
exports.cd = wrap('cd', _cd);

//@
//@ #### pwd()
//@ Returns the current directory.
function _pwd(options) {
  return path.resolve(process.cwd());
};
exports.pwd = wrap('pwd', _pwd);

//@
//@ #### cp('[-options] source [source ...] dest')
//@ Available options:
//@
//@ + `f`: force
//@ + `r, R`: recursive
//@
//@ The wildcard `*` is accepted.
function _cp(options, str) {
  var options = parseOptions(str, {
    'f': 'force',
    'R': 'recursive',
    'r': 'recursive'
  });
  var files = parsePaths(str);

  // Get sources, dest
  var sources, dest;
  if (files.length < 2) {
    error('missing <source> and/or <dest>');
  } else {
    sources = files.slice(0, files.length - 1);
    dest = files[files.length - 1];
  }

  // Dest is not existing dir, but multiple sources given
  if ((!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) && sources.length > 1)
    error('dest is not a directory (too many sources)');

  // Dest is an existing file, but no -f given
  if (fs.existsSync(dest) && fs.statSync(dest).isFile() && !options.force)
    error('dest file already exists: ' + dest);

  sources = expand(sources);

  sources.forEach(function(src) {
    if (!fs.existsSync(src)) {
      error('no such file or directory: '+src, true);
      return; // skip file
    }

    // If here, src exists

    if (fs.statSync(src).isDirectory()) {
      if (!options.recursive) {
        // Non-Recursive
        log(src + ' is a directory (not copied)');
      } else {
        // Recursive
        // 'cp /a/source dest' should create 'source' in 'dest'
        var newDest = dest+'/'+path.basename(src),
            checkDir = fs.statSync(src);
        try {
          fs.mkdirSync(newDest, checkDir.mode);
        } catch (e) {
          //if the directory already exists, that's okay
          if (e.code !== 'EEXIST') throw e;
        }
        cpdirSyncRecursive(src, newDest, {force: options.force});
      }
      return; // done with dir
    }

    // If here, src is a file

    // When copying to '/path/dir':
    //    thisDest = '/path/dir/file1'
    var thisDest = dest;
    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory())
      thisDest = path.normalize(dest + '/' + path.basename(src));

    if (fs.existsSync(thisDest) && !options.force) {
      error('dest file already exists: ' + thisDest, true);
      return; // skip file
    }

    copyFileSync(src, thisDest);
  }); // forEach(src)
}; // cp
exports.cp = wrap('cp', _cp);

//@
//@ #### rm('[-options] file [file ...]')
//@ Available options:
//@
//@ + `f`: force
//@ + `r, R`: recursive
//@
//@ The wildcard `*` is accepted.
function _rm(options, str) {
  var options = parseOptions(str, {
    'f': 'force',
    'r': 'recursive',
    'R': 'recursive'
  });
  var files = parsePaths(str);

  if (files.length === 0)
    error('no paths given');

  files = expand(files);

  files.forEach(function(file) {
    if (!fs.existsSync(file)) {
      // Path does not exist, no force flag given
      if (!options.force)
        error('no such file or directory: '+file, true);

      return; // skip file
    }

    // If here, path exists

    // Remove simple file
    if (fs.statSync(file).isFile()) {
      fs.unlinkSync(file);
      return;
    }

    // Path is an existing directory, but no -r flag given
    if (fs.statSync(file).isDirectory() && !options.recursive) {
      error('path is a directory', true);
      return; // skip path
    }

    // Recursively remove existing directory
    if (fs.statSync(file).isDirectory() && options.recursive) {
      rmdirSyncRecursive(file);
    }
  }); // forEach(file)
}; // rm
exports.rm = wrap('rm', _rm);

//@
//@ #### mv('source [source ...] dest')
//@ Available options:
//@
//@ + `f`: force
//@
//@ The wildcard `*` is accepted.
function _mv(options, str) {
  var options = parseOptions(str, {
    'f': 'force'
  });
  var files = parsePaths(str);

  // Get sources, dest
  var sources, dest;
  if (files.length < 2) {
    error('missing <source> and/or <dest>');
  } else {
    sources = files.slice(0, files.length - 1);
    dest = files[files.length - 1];
  }

  sources = expand(sources);

  // Dest is not existing dir, but multiple sources given
  if ((!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) && sources.length > 1)
    error('dest is not a directory (too many sources)');

  // Dest is an existing file, but no -f given
  if (fs.existsSync(dest) && fs.statSync(dest).isFile() && !options.force)
    error('dest file already exists: ' + dest);

  sources.forEach(function(src) {
    if (!fs.existsSync(src)) {
      error('no such file or directory: '+src, true);
      return; // skip file
    }

    // If here, src exists

    // When copying to '/path/dir':
    //    thisDest = '/path/dir/file1'
    var thisDest = dest;
    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory())
      thisDest = path.normalize(dest + '/' + path.basename(src));

    if (fs.existsSync(thisDest) && !options.force) {
      error('dest file already exists: ' + thisDest, true);
      return; // skip file
    }

    if (path.resolve(src) === path.dirname(path.resolve(thisDest))) {
      error('cannot move to self: '+src, true);
      return; // skip file
    }

    fs.renameSync(src, thisDest);
  }); // forEach(src)
}; // mv
exports.mv = wrap('mv', _mv);

//@
//@ #### mkdir('[-options] dir [dir ...]')
//@ Available options:
//@
//@ + `p`: full path (will create intermediate dirs if necessary)
function _mkdir(options, str) {
  var options = parseOptions(str, {
    'p': 'fullpath'
  });
  var dirs = parsePaths(str);

  if (dirs.length === 0)
    error('no directories given');

  dirs.forEach(function(dir) {
    if (fs.existsSync(dir)) {
      if (!options.fullpath)
          error('path already exists: ' + dir, true);
      return; // skip dir
    }

    // Base dir does not exist, and no -p option given
    var baseDir = path.dirname(dir);
    if (!fs.existsSync(baseDir) && !options.fullpath) {
      error('no such file or directory: ' + baseDir, true);
      return; // skip dir
    }

    if (options.fullpath)
      mkdirSyncRecursive(dir);
    else
      fs.mkdirSync(dir, 0777);
  });
}; // mkdir
exports.mkdir = wrap('mkdir', _mkdir);

//@
//@ #### cat('file [file ...]')
//@ Returns a string containing the given file, or a concatenated string
//@ containing the files if more than one file is given (a new line character is
//@ introduced between each file). Wildcards are accepted.
function _cat(options, str) {
  var files = parsePaths(str),
      cat = '';

  files = expand(files);
  if (files.length === 0)
    error('no files given');

  files.forEach(function(file) {
    if (!fs.existsSync(file))
      error('no such file or directory: ' + file);

    cat += fs.readFileSync(file, 'utf8') + '\n';
  });

  if (cat[cat.length-1] === '\n')
    cat = cat.substring(0, cat.length-1);

  return cat;
};
exports.cat = wrap('cat', _cat);

//@
//@ #### 'any string'.to('file')
//@ Analogous to the redirection operator `>` in Unix, but works with JavaScript strings. 
//@ For example, to redirect the output of `cat()` to a file, use: `cat('input.txt').to('output.txt')`. 
//@ _Like Unix redirections, `to()` will overwrite any existing file!_
function _to(options, file) {
  if (!file)
    error('wrong arguments');

  if (!fs.existsSync( path.dirname(file) ))
      error('no such file or directory: ' + path.dirname(file));

  fs.writeFileSync(file, this.toString(), 'utf8');
};
String.prototype.to = wrap('to', _to);

//@
//@ #### sed(search_regex, 'replace_str', 'file' [, options])
//@ Available options:
//@
//@ + `inplace`: (Default is `false`) If `true` will replace contents of 'file' with 
//@ the modified string. _Note that no backups will be created!_
//@
//@ Reads an input string from `file` and performs a JavaScript `replace()` on the input
//@ using the given search regex and replacement string. Returns the modified string.
function _sed(options, regex, replacement, file, options) {
  if (typeof replacement === 'string')
    replacement = replacement; // no-op
  else if (typeof replacement === 'number')
    replacement = replacement.toString(); // fallback
  else
    error('invalid replacement string');

  if (!file)
    error('no file given');

  if (!fs.existsSync(file))
    error('no such file or directory: ' + file);

  var result = fs.readFileSync(file, 'utf8').replace(regex, replacement);
  if (options && options.inplace)
    result.to(file);

  return result;
};
exports.sed = wrap('sed', _sed);

//@
//@ #### grep(regex_filter, 'file [file ...]')
//@ Reads input string from given files and returns a string containing all lines of the 
//@ file that match the given `regex_filter`. Wildcards are accepted for file names.
function _grep(options, regex, filesStr) {
  if (!filesStr)
    error('no file given');

  var files = parsePaths(filesStr);
  files = expand(files);

  var grep = '';
  files.forEach(function(file) {
    if (!fs.existsSync(file)) {
      error('no such file or directory: ' + file, true);
      return;
    }

    var contents = fs.readFileSync(file, 'utf8'),
        lines = contents.split(/\r*\n/);
    lines.forEach(function(line) {
      if (line.match(regex))
        grep += line + '\n';
    });
  });

  return grep;
};
exports.grep = wrap('grep', _grep);

//@
//@ #### exit(code)
//@ Exits the current process with the given exit code.
exports.exit = process.exit;

//@
//@ #### env['VAR_NAME']
//@ Object containing environment variables (both getter and setter). Shortcut to process.env.
exports.env = process.env;





//@
//@ ## Other commands
//@





//@
//@ #### external('command', options)
//@ Checks that the external `command` exists either as an absolute path or in the system `PATH`, 
//@ and returns a callable function `function([args] [,options] [,callback])` that executes the 
//@ command. Example:
//@
//@ ```javascript
//@ var git = external('git'),
//@     gitVersion = git('--version').output;
//@ ```
//@
//@ Available options:
//@
//@ + `required`: (Default is `false`) If `true`, will throw an error when command cannot be found.
//@ + `silent`: (Default is `false`) If `true` will suppress all output from command, otherwise both `stdout` and `stderr`
//@ will be redirected to the console.
//@ + `async`: (Default is `false`) If `true` will call the optional `callback` argument to the 
//@ callable function when the command is done, instead of blocking execution.
//@
//@ When in synchronous mode the callable function returns the object `{ code:..., output:... }`, 
//@ containing the program's `output` (stdout + stderr)  and its exit `code`. 
//@ Otherwise the `callback` gets the arguments `(code, output)`.
exports.external = wrap('external', function(cmd, opts) {
  if (!cmd)
    error('must specify command');

  var options = extend({
    silent: false,
    required: false,
    async: false
  }, opts);

  var pathEnv = process.env.path || process.env.Path || process.env.PATH,
      pathArray = splitPath(pathEnv),
      where = null;

  write('Checking for external command availability: ' + cmd + ' ... ');

  // No relative/absolute paths provided?
  if (cmd.search(/\//) === -1) {
    // Search for command in PATH
    pathArray.forEach(function(dir) {
      if (where)
        return; // already found it

      var attempt = path.resolve(dir + '/' + cmd);
      if (fs.existsSync(attempt)) {
        where = attempt;
        return;
      }

      if (platform === 'win') {
        var baseAttempt = attempt;
        attempt = baseAttempt + '.exe';
        if (fs.existsSync(attempt)) {
          where = attempt;
          return;
        }
        attempt = baseAttempt + '.cmd';
        if (fs.existsSync(attempt)) {
          where = attempt;
          return;
        }
        attempt = baseAttempt + '.bat';
        if (fs.existsSync(attempt)) {
          where = attempt;
          return;
        }
      } // if 'win'
    });
  }
    
  // Command not found anywhere?
  if (!fs.existsSync(cmd) && !where) {
    state.fatal = options.required;
    log('NO');

    if (state.fatal)
      error('Fatal: could not find required command');

    return null;
  }

  log('OK');
  where = where || path.resolve(cmd);

  // Callable function
  return function(args, options2, callback) {
    if (typeof args === 'string' && typeof options2 === 'object' && typeof callback === 'function') {
      // nothing to do
    } else if (typeof args === 'function') {
      callback = args;
      args = '';
      options2 = {};
    } else if (typeof options2 === 'function') {
      callback = options2;
      if (typeof args === 'object') {
        options2 = args;
        args = '';
      }
    } else if (typeof args === 'object') {
      options2 = args;
      args = '';
    }

    var thisOpts = extend({}, options); // clone 'global' opts
    thisOpts = extend(thisOpts, options2); // override global opts with local opts
  
    if (thisOpts.async)
      execAsync(where, args, thisOpts, callback);
    else
      return execSync(where, args, thisOpts);

  } // callable function
});

//@
//@ #### exists('path [path ...]')
//@ Returns true if all the given paths exist.
function _exists(str) {
  var options = parseOptions(str, {});
  var paths = parsePaths(str);

  if (paths.length === 0)
    error('no paths given');

  var exists = true;
  paths.forEach(function(p) {
    if (!fs.existsSync(p))
      exists = false;
  });

  return exists;
};
exports.exists = wrap('exists', _exists);

//@
//@ #### tempdir()
//@ Searches and returns string containing a writeable, platform-dependent temporary directory.
//@ Follows Python's [tempfile algorithm](http://docs.python.org/library/tempfile.html#tempfile.tempdir).
exports.tempdir = tempDir;

//@
//@ #### error()
//@ Tests if error occurred. Returns `null` if no error occurred in the last command. Otherwise returns a string
//@ explaining the error
exports.error = function() {
  return state.error;
}

//@
//@ #### verbose()
//@ Enables all output (default)
exports.verbose = function() {
  state.silent = false;
}

//@
//@ #### silent()
//@ Suppresses all output, except for explict `echo()` calls
exports.silent = function() {
  state.silent = true;
}














////////////////////////////////////////////////////////////////////////////////////////////////
//
// Auxiliary functions (internal use only)
//

function log(msg) {
  if (!state.silent)
    console.log(msg);
}

function write(msg) {
  if (!state.silent)
    process.stdout.write(msg);
}

// Shows error message. Throws unless '_continue = true'.
function error(msg, _continue) {
  if (state.error === null)
    state.error = '';
  state.error += state.currentCmd + ': ' + msg + '\n';
  
  log(state.error);

  if (!_continue)
    throw '';
}

// Returns {'alice': true, 'bob': false} when passed:
//   parseOptions('-a', {'a':'alice', 'b':'bob'});
function parseOptions(str, map) {
  if (!map)
    error('parseOptions() internal error: no map given');

  // All options are false by default
  var options = {};
  for (letter in map)
    options[map[letter]] = false;

  if (!str)
    return options; // defaults

  if (typeof str !== 'string')
    error('parseOptions() internal error: wrong str');

  // e.g. match[1] = 'Rf' for str = '-Rf'
  var match = str.match(/^\-(.+)/);
  if (!match)
    return options;

  // e.g. chars = ['R', 'f']
  var chars = match[1].split('');

  chars.forEach(function(char) {
    if (char in map)
      options[map[char]] = true;
    else
      error('option not recognized: '+char);
  });

  return options;
}

// Common wrapper for all Unix-like commands
function wrap(cmd, fn) {
  return function() {
    var retValue = null;

    state.currentCmd = cmd;
    state.error = null;

    try {
      var args = [].slice.call(arguments, 0);
      if (args.length === 0 || args[0][0] !== '-')
        args.unshift(''); // only add dummy option if '-option' not already present
      retValue = fn.apply(this, args);
    } catch (e) {
      if (!state.error) {
        // If state.error hasn't been set it's an error thrown by Node, not us - probably a bug...
        console.log('maker.js: internal error');
        console.log(e.stack || e);
        process.exit(1);
      }
      if (state.fatal)
        throw e;
    }

    state.currentCmd = 'maker.js';
    return retValue;
  }
} // wrap

// Buffered file copy, synchronous
// (Using readFileSync() + writeFileSync() could easily cause a memory overflow
//  with large files)
function copyFileSync(srcFile, destFile) {
  if (!fs.existsSync(srcFile))
    error('copyFileSync: no such file or directory: ' + srcFile);

  var BUF_LENGTH = 64*1024,
      buf = new Buffer(BUF_LENGTH),
      fdr = fs.openSync(srcFile, 'r'),
      fdw = fs.openSync(destFile, 'w'),
      bytesRead = BUF_LENGTH,
      pos = 0;

  while (bytesRead === BUF_LENGTH) {
    bytesRead = fs.readSync(fdr, buf, 0, BUF_LENGTH, pos);
    fs.writeSync(fdw, buf, 0, bytesRead);
    pos += bytesRead;
  }

  fs.closeSync(fdr);
  fs.closeSync(fdw);
}

// Recursively copies 'sourceDir' into 'destDir'
// Adapted from https://github.com/ryanmcgrath/wrench-js
//
// Copyright (c) 2010 Ryan McGrath
// Copyright (c) 2012 Artur Adib
//
// Licensed under the MIT License
// http://www.opensource.org/licenses/mit-license.php
function cpdirSyncRecursive(sourceDir, destDir, opts) {
  if (!opts) opts = {};

  /* Create the directory where all our junk is moving to; read the mode of the source directory and mirror it */
  var checkDir = fs.statSync(sourceDir);
  try {
    fs.mkdirSync(destDir, checkDir.mode);
  } catch (e) {
    //if the directory already exists, that's okay
    if (e.code !== 'EEXIST') throw e;
  }

  var files = fs.readdirSync(sourceDir);

  for(var i = 0; i < files.length; i++) {
    var currFile = fs.lstatSync(sourceDir + "/" + files[i]);

    if (currFile.isDirectory()) {
      /* recursion this thing right on back. */
      cpdirSyncRecursive(sourceDir + "/" + files[i], destDir + "/" + files[i], opts);
    } else if (currFile.isSymbolicLink()) {
      var symlinkFull = fs.readlinkSync(sourceDir + "/" + files[i]);
      fs.symlinkSync(symlinkFull, destDir + "/" + files[i]);
    } else {
      /* At this point, we've hit a file actually worth copying... so copy it on over. */
      if (fs.existsSync(destDir + "/" + files[i]) && !opts.force) {
        log('skipping existing file: ' + files[i]);
      } else {
        copyFileSync(sourceDir + "/" + files[i], destDir + "/" + files[i]);
      }
    }

  } // for files
}; // cpdirSyncRecursive

// Recursively removes 'dir'
// Adapted from https://github.com/ryanmcgrath/wrench-js
//
// Copyright (c) 2010 Ryan McGrath
// Copyright (c) 2012 Artur Adib
//
// Licensed under the MIT License
// http://www.opensource.org/licenses/mit-license.php
function rmdirSyncRecursive(dir) {
  var files;

  files = fs.readdirSync(dir);

  // Loop through and delete everything in the sub-tree after checking it
  for(var i = 0; i < files.length; i++) {
    var currFile = fs.lstatSync(dir + "/" + files[i]);

    if(currFile.isDirectory()) // Recursive function back to the beginning
      rmdirSyncRecursive(dir + "/" + files[i]);

    else if(currFile.isSymbolicLink()) // Unlink symlinks
      fs.unlinkSync(dir + "/" + files[i]);

    else // Assume it's a file - perhaps a try/catch belongs here?
      fs.unlinkSync(dir + "/" + files[i]);
  }

  // Now that we know everything in the sub-tree has been deleted, we can delete the main directory. 
  // Huzzah for the shopkeep.
  return fs.rmdirSync(dir);
}; // rmdirSyncRecursive

// Recursively creates 'dir'
function mkdirSyncRecursive(dir) {
  var baseDir = path.dirname(dir);

  // Base dir exists, no recursion necessary
  if (fs.existsSync(baseDir)) {
    fs.mkdirSync(dir, 0777);
    return;
  }

  // Base dir does not exist, go recursive
  mkdirSyncRecursive(baseDir);

  // Base dir created, can create dir
  fs.mkdirSync(dir, 0777);
};

// e.g. 'makerjs_a5f185d0443ca...'
function randomFileName() {
  function randomHash(count) {
    if (count === 1)
      return parseInt(16*Math.random()).toString(16);
    else {
      var hash = '';
      for (var i=0; i<count; i++)
        hash += randomHash(1);
      return hash;
    }
  }

  return 'makerjs_'+randomHash(20);
}

// Returns false if 'dir' is not a writeable directory, 'dir' otherwise
function writeableDir(dir) {
  if (!dir || !fs.existsSync(dir))
    return false;

  if (!fs.statSync(dir).isDirectory())
    return false;

  var testFile = dir+'/'+randomFileName();
  try {
    fs.writeFileSync(testFile, ' ');
    fs.unlinkSync(testFile);
    return dir;
  } catch (e) {
    return false;
  }
}

// Cross-platform method for getting an available temporary directory.
// Follows the algorithm of Python's tempfile.tempdir
// http://docs.python.org/library/tempfile.html#tempfile.tempdir
function tempDir() {
  if (state.tempDir)
    return state.tempDir; // from cache

  state.tempDir = writeableDir(process.env['TMPDIR']) ||
                  writeableDir(process.env['TEMP']) ||
                  writeableDir(process.env['TMP']) ||
                  writeableDir(process.env['Wimp$ScrapDir']) || // RiscOS
                  writeableDir('C:\\TEMP') || // Windows
                  writeableDir('C:\\TMP') || // Windows
                  writeableDir('\\TEMP') || // Windows
                  writeableDir('\\TMP') || // Windows
                  writeableDir('/tmp') ||
                  writeableDir('/var/tmp') ||
                  writeableDir('/usr/tmp') ||
                  writeableDir('.'); // last resort
  
  return state.tempDir;
}

// Wrapper around exec() to enable echoing output to console in real time
function execAsync(cmd, args, opts, callback) {
  var output = '';
  
  var c = child.exec(formCommandLine(cmd, args), {env: process.env}, function(err) {
    if (callback) 
      callback(err ? err.code : 0, output);
  });

  c.stdout.on('data', function(data) {
    output += data;
    if (!opts.silent)
      write(data);
  });

  c.stderr.on('data', function(data) {
    output += data;
    if (!opts.silent)
      write(data);
  });
}

// Hack to run child_process.exec() synchronously (sync avoids callback hell)
// Uses a custom wait loop that checks for a flag file, created when the child process is done.
// (Can't do a wait loop that checks for internal Node variables/messages as
// Node is single-threaded; callbacks and other internal state changes are done in the 
// event loop).
function execSync(cmd, args, opts) {
  var stdoutFile = path.resolve(tempDir()+'/'+randomFileName()),
      codeFile = path.resolve(tempDir()+'/'+randomFileName()),
      scriptFile = path.resolve(tempDir()+'/'+randomFileName());

  var options = extend({
    silent: false
  }, opts);

  var previousStdoutContent = '';
  // Echoes stdout changes from running process, if not silent
  function updateStdout() {
    if (state.silent || options.silent || !fs.existsSync(stdoutFile))
      return;

    var stdoutContent = fs.readFileSync(stdoutFile, 'utf8');
    // No changes since last time?
    if (stdoutContent.length <= previousStdoutContent.length)
      return;

    process.stdout.write(stdoutContent.substr(previousStdoutContent.length));
    previousStdoutContent = stdoutContent;
  }

  function escape(str) {
    str = str.replace(/\'/g, '"');
    str = str.replace(/\\/g, '\\\\');
    return str;
  }
    
  var cmdLine = formCommandLine(cmd, args);  
  cmdLine += ' > '+stdoutFile+' 2>&1'; // works on both win/unix

  var script = 
   "var child = require('child_process'), \
        fs = require('fs'); \
    child.exec('"+escape(cmdLine)+"', {env: process.env}, function(err) { \
      fs.writeFileSync('"+escape(codeFile)+"', err ? err.code.toString() : '0'); \
    });";

  if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile);
  if (fs.existsSync(stdoutFile)) fs.unlinkSync(stdoutFile);
  if (fs.existsSync(codeFile)) fs.unlinkSync(codeFile);

  fs.writeFileSync(scriptFile, script);
  child.exec('node '+scriptFile, { 
    env: process.env,
    cwd: exports.pwd()
  });

  // The wait loop
  while (!fs.existsSync(codeFile)) { updateStdout(); };
  while (!fs.existsSync(stdoutFile)) { updateStdout(); };

  // At this point codeFile exists, but it's not necessarily flushed yet.
  // Keep reading it until it is.
  var code = parseInt('');
  while (isNaN(code))
    code = parseInt(fs.readFileSync(codeFile, 'utf8'));

  var stdout = fs.readFileSync(stdoutFile, 'utf8');

  fs.unlinkSync(scriptFile);
  fs.unlinkSync(stdoutFile);
  fs.unlinkSync(codeFile);

  // True if successful, false if not
  var obj = {
    code: code,
    output: stdout
  };
  return obj;
} // execSync()

// Expands wildcards with matching file names. For a given array of file names 'list', returns 
// another array containing all file names as per ls(list[i]). 
// For example: expand(['file*.js']) = ['file1.js', 'file2.js', ...]
// (if the files 'file1.js', 'file2.js', etc, exist in the current dir)
function expand(list) {
  var expanded = [];
  list.forEach(function(listEl) {
    // Wildcard present? 
    if (listEl.search(/\*/) > -1) {
      for (file in _ls(listEl))
        expanded.push(file);
    } else {
      expanded.push(listEl);
    }
  });  
  return expanded;
}

// Cross-platform method for splitting environment PATH variables
function splitPath(p) {
  if (!p)
    return [];

  if (platform === 'win')
    return p.split(';');
  else
    return p.split(':');
}

// extend(target_obj, source_obj1 [, source_obj2 ...])
// Shallow extend, e.g.:
//    aux.extend({a:1}, {b:2}, {c:3}) 
//    returns {a:1, b:2, c:3}
function extend(target) {
  var sources = [].slice.call(arguments, 1);
  sources.forEach(function(source) {
    for (key in source) 
      target[key] = source[key];
  });
  
  return target;
}

// Normalize platform-dependent command line
function formCommandLine(cmd, args) {
  if (platform === 'win')
    cmd = '\"'+cmd+'\"'; // wrap in quotes to avoid issues with space

  return cmd + (args ? ' '+args : '');
}