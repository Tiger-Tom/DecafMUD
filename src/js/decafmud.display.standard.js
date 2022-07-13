/*!
 * DecafMUD v0.9.0
 * http://decafmud.stendec.me
 *
 * Copyright 2010, Stendec <stendec365@gmail.com>
 */

/**
 * @fileOverview DecafMUD Display Provider: Standard
 * @author Stendec <stendec365@gmail.com>
 * @version 0.9.0
 */

(function(DecafMUD) { // Wrapper function to automatically clean up variables

let addEvent = function(node, etype, func) {
	if (node.addEventListener) {
		node.addEventListener(etype, func, false);
		return;
	}
	etype = `on${etype}`;
	if (node.attachEvent) {
		node.attachEvent(etype, func);
	} else {
		node[etype] = func;
	}
};
let delEvent = function(node, etype, func) {
	if (node.removeEventListener) {
		node.removeEventListener(etype, func, false);
	}
};

/** This is the standard display handler for DecafMUD, and should generally be
 *  good enough for just about anything you'd need to do. It has support for
 *  many ANSI sequences, XTERM-style 256 colors, MXP, multiple output panes,
 *  and limiting available scrollback for performance reasons.
 *
 * @example
 * var ESC = "\x1B";
 * decaf.display.handleData(ESC + "[0m"); // Reset the ANSI SGR Settings
 *
 * @name Display
 * @class DecafMUD Display Provider: Standard
 * @exports Display as DecafMUD.plugins.Display.standard
 */
let Display = function(decaf, ui, disp) {
	// Store DecafMUD, Interface, and Display element
	this.decaf = decaf;
	this.ui = ui;
	this._display = disp;
	// Create an element for the display
	this.display = document.createElement('div');
	this.display.className = `decafmud display ${this.decaf.options.set_display.fgclass}7`;
	this._display.appendChild(this.display);
	// Attach the scroll event
	addEvent(this._display, 'scroll', this.onScroll);
	// Attach the middle-click event
	addEvent(this._display, 'mousedown', function(e) {
		if (e.which !== 2 || !this.decaf.store.get('ui/middle-click-scroll', false)) {
			return;
		}
		this.scroll();
		if (e.cancelBubble) {
			e.cancelBubble = true;
		}
		e.preventDefault();
	});
	// Store this plugin in DecafMUD
	this.decaf.loaded_plugs.display = this;
	// Any HTML currently within the display is our splash text, store it
	this.splash = this.display.innerHTML;
	// Clear the display, initializing the default state as well
	this.orig_title = null;
	this.clear();
	// Display the DecafMUD banner
	this.message(`<br><a href="https://github.com/MUME/DecafMUD">DecafMUD</a> v${DecafMUD.version} by Stendec&lt;<a href="mailto:stendec365@gmail.com">stendec365@gmail.com</a>&gt;<br>`);
	if (this.splash.length) {
		this.message(`${this.splash}<br>`);
	}
};

/** Bitmask flags */
const BRIGHT = 1, //     00000001
	NEGATIVE = 2, //   00000010
	ITALIC = 4, //     00000100
	BLINK = 8, //      00001000
	UNDERLINE = 16, // 00010000
	FAINT = 32, //     00100000
	STRIKE = 64, //    01000000
	DBLUNDER = 128; // 10000000

/** Defaults */
Display.prototype.state = 0;
Display.prototype.c_fg = 7;
Display.prototype.c_bg = 0;
Display.prototype.c_fnt = 0;
Display.prototype.readyClear = false;
Display.prototype.endSpace = false;
Display.prototype.scrollTime = null;
Display.prototype.willScroll = false;
Display.prototype.vt100Warning = false;
Display.prototype.mxp = false;

/** Display clear function */
Display.prototype.clear = function() {
	clearTimeout(this.scrollTime);
	this.display.innerHTML = '';
	this.reset();
	this.inbuf = [];
	this.outbuf = [];
};

/** Reset the display */
Display.prototype.reset = function(onlySetVars=false) {
	this.state = 0;
	this.c_fg = 7;
	this.c_bg = 0;
	this.c_fnt = 0;
	if (onlySetVars) {
		return;
	}
	this.readyClear = false;
	this.endSpace = false;
};

/** Get the scrollbar width */
Display.prototype.sbw = undefined;
Display.prototype.scrollbarWidth = function() {
	if (this.sbw !== undefined) {
		return this.sbw;
	}
	// Attempt to guess it
	if (this._display.offsetWidth > this._display.clientWidth) {
		this.sbw = this._display.offsetWidth - this._display.clientWidth;
		return this.sbw;
	}
	// Return 15 if we can't guess it
	return 15;
};

/** Get the size of TELOPT_NAWS */
Display.prototype.cz = undefined;
Display.prototype.charSize = function() {
	if (this.cz !== undefined) {
		return this.cz;
	}
	const span = document.createElement('span');
	span.innerHTML = 'W';
	this.display.appendChild(span);
	this.cz = [span.offsetWidth, span.offsetHeight];
	this.display.removeChild(span);
	return this.cz;
};

/** Get the size (inner width, height) of the display */
Display.prototype.getSize = function() {
	let sbw = 
		(this.decaf.options.set_display.scrollbarwidth !== undefined) ? this.decaf.options.set_display.scrollbarwidth : this.scrollbarWidth();
	const tw = this._display.clientWidth - sbw,
		th = this._display.clientHeight,
		sz = this.charSize();
	return [Math.floor(tw/sz[0]) + 1, Math.floor(th/sz[1])];
};

/** Add data to the inbuf and process it */
Display.prototype.handleData = function(d) {
	this.inbuf.push(d);
	this.processBuffer();
};

/** Process the data in the inbuf */
Display.prototype.processBuffer = function() {
	// Leave if there isn't any data to process
	if (this.inbuf.length < 1) {
		return;
	}
	// Convert the data to a single string and clear the inbuf
	let data = this.inbuf.join('');
	this.inbuf = [];
	// Cache variables (stack is evil)
	const ESC = DecafMUD.ESC,
		splitter = /\x1B/;
	// Loop through the string
	while (data.length > 0) {
		// Find the first instance of ESC
		let ind = data.indexOf(ESC);
		// If there isn't an instance of ESC, push the data out and break
		if (ind === -1) {
			this.outbuf.push(data.replace(/</g, '&lt;'));
			break;
		}
		// Push any text before the sequence to the output buffer
		if (ind > 0) {
			this.readyClear = false;
			this.outbuf.push(data.substr(0, ind).replace(/</g, '&lt;'));
			data = data.substr(ind);
		}
		// Handle the ANSI code
		let out = this.readANSI(data);
		if (out === false) { // We don't have the entire code, push the data back into inbuf and continue processing what we do have
			this.inbuf.push(data);
			break;
		}
		// Process the rest next loop
		data = out;
	}
	// Push the output buffer to the display
	data = this.outbuf.join('');
	this.outbuf = [];
	this.outColor(false);
	this.needline = !data.endsWith('\n');
	/// Set ARIA busy
	this._display.setAttribute('aria-busy', true);
	/// Add the data to a span object and append that to the main display
	const span = document.createElement('span');
	span.innerHTML = data.replace(/\n\r?/g, '<br>')
		.replace(/> /g, '>&nbsp;')
		.replace(/ ( +)/g, (m) => { 
			return ` ${'&nbsp;'.repeat(m.length-1)}`;
		});
	this.shouldScroll();
	this.display.appendChild(span);
	this.doScroll();
};

/** Read an ANSI sequence from the provided data and handle it, then return the
 *  remaining text. If the sequence is not complete, then return false.
 * @param {String} data The data to read an ANSI sequence from.
 * @returns {String|boolean} A string if an ANSI sequence has been read
 *    successfully, else the boolean false. */
Display.prototype.readANSI = function(data) {
	if (data.length < 2) {
		return false;
	}
	// If the second character is '[', read until the next letter
	if (data.charAt(1) === '[') {
		const ind = data.substr(2).search(/[x40-\x7E]/);
		if (ind === -1) {
			return false;
		}
		ind += 2;
		this.handleAnsiCSI(data.substr(2, ind-1));
		return data.substr(ind+1);
	}
	// If the second character is ']', read until either a BEL or an 'ESC\'
	else if (data.charAt(1) == ']') {
		let ind = data.substr(2).indexOf(DecafMUD.BEL),
			in2 = data.substr(2).indexOf(`${DecafMUD.ESC}\\`);
		if (in2 < ind || ind === -1) {
			ind = in2;
		}
		if (ind === -1) {
			return false;
		}
		ind += 2;
		return data.substr(ind);
	}
	// Push the ESC off the stack, it's obviously bad
	return data.substr(1);
};

/** Handle an ANSI CSI ( ESC[ ) sequence. This is for internal use only.
 * @param {String} seq The sequence to handle. */
Display.prototype.handleAnsiCSI = function(seq) {
	switch(seq.charAt(seq.length-1)) {
		// SGR (Select Graphic Rendition) is first because it's the most likely
		// to occur and we don't want to waste time comparing against other
		// possibilities first.
		case 'm':
			const old = [this.state, this.c_fg, this.c_bg, this.c_fnt];
			if (seq.length === 1) {
				seq = '0m';
			}
			const cs = seq.substr(0, seq.length-1).split(';'),
				l = cs.length;
			for (let i = 0; i < l; i++) { // Use this version of the for loop instead of "of" or "in" so that we can easily skip multiple indexes
				let c = parseInt(cs[i]);
				if (c === 38) { // XTERM FG color
					i += 2;
					if (i >= l) {
						break;
					}
					this.c_fg = parseInt(cs[i]);
				} else if (c === 39) { // Default color
					this.c_fg = 7;
				} else if (c === 48) { // XTERM BG color
					i += 2;
					if (i >= l) {
						break;
					}
					this.c_bg = parseInt(cs[i]);
				} else if (c > 29 && c < 38) { // FG color
					this.c_fg = c - 30;
				} else if (c < 48) { // BG color
					this.c_bg = c - 40;
				} else if (c === 0) { // Reset
					this.reset(true);
				} else if (c === 1) { // Bright
					this.state |= BRIGHT;
					this.state &= ~FAINT;
				} else if (c === 2) { // Faint
					this.state |= FAINT;
					this.state &= ~BRIGHT;
				} else if (c === 3) { // Italic
					this.state |= ITALIC;
				} else if (c === 4) { // Underline
					this.state |= UNDERLINE;
					this.state &= ~DBLUNDER;
				} else if (c < 7) { // Blink
					this.state |= BLINK;
				} else if (c === 7) { // Negative
					this.state |= NEGATIVE;
				} else if (c === 8) { // Conceal
					this.decaf.debugString('Conceal ANSI CSI SGR recieved, but unsupported. Ignored.');
				} else if (c === 9) { // Strikethrough
					this.state |= STRIKE;
				} else if (c === 20) { // Font
					this.c_fnt = c - 10;
				} else if (c === 21) { // Double underline
					this.state |= DBLUNDER;
					this.state &= ~UNDERLINE;
				} else if (c === 22) { // Normal intensity
					this.state &= ~(BRIGHT | FAINT);
				} else if (c === 23) { // Italics off
					this.state &= ~ITALIC;
				} else if (c === 24) { // Underline off
					this.state &= ~(UNDERLINE | DBLUNDER);
				} else if (c === 25) { // Blink off
					this.state &= ~BLINK;
				} else if (c === 29) { // Negative off
					this.state &= ~NEGATIVE;
				} else if (c === 49) { // Default BG color
					this.c_bg = 0;
				} else if (c > 89 && c < 98) { // Bright FG color
					this.state |= BRIGHT;
					this.state &= ~FAINT;
					this.c_fg = c - 90;
				} else if (c > 99 && c < 108) { // Bright BG color
					this.c_bg = c - 92;
				}
			}
			// Has the state changed?
			if ([this.state, this.c_fg, this.c_bg, this.c_fnt] !== old) {
				this.outColor();
			}
			this.readyClear = false;
			return;
		case '@': //Insert characters
		case 'C': // Move cursor
			var count = (seq.length > 1) ? parseInt(seq.substr(0, seq.length-1)) : 1;
			this.outbuf.push(' '.repeat(count));
			this.readyClear = false;
			return;
		case 'E': // Cursor next line
			var count = (seq.length > 1) ? parseInt(seq.substr(0, seq.length-1)) : 1;
			this.outbuf.push('\n'.repeat(count));
			this.readyClear = false;
			return;
		case 'H':
			if (seq.length === 1) {
				this.readyClear = true;
			}
			return;
		case 'J': // Clear screen
			var mode = (seq.length > 1) ? parseInt(seq.substr(0, seq.length-1)) : 0;
			if ((mode === 0 && this.readyClear) || mode === 2) {
				this.clear();
			}
			this.readyClear = false;
			return;
		case 'K': // Erase in line
			var mode = (seq.length > 1) ? parseInt(seq.substr(0, seq.length-1)) : 0;
			if (mode === 2) {
				let found = false;
				if (this.outbuf.length > 0) {
					// Find the last \n in outbuf and go to it
					while (this.outbuf.length > 0) {
						const st = this.outbuf[this.outbuf.length-1];
						if (st.lastIndexOf('\n') === -1) {
							this.outbuf.pop();
						} else {
							found = true;
							this.outbuf[this.outbuf.length-1] = st.substr(0, st.lastIndexOf('\n')+1);
							break;
						}
					}
				}
				if (!found) {
					// Find the last <br> in the scrollback
					while (this.display.childElementCount > 0) {
						const last = this.display.children[this.display.childElementCount-1];
						if (last.innerHTML.lastIndexOf('<br>') === -1) {
							this.display.removeChild(last);
						} else {
							found = true;
							last.innerHTML = last.innerHTML.substr(0, last.innerHTML.lastIndexOf('<br>')+4);
							break;
						}
					}
				}
			} else if (mode === 1) {
				this.decaf.debugString(`ANSI Sequence ESC [${seq} -- TODO: Mode 1`);
			}
			return;
	}
	if ('ABCDEFGHJKSTfnsulh'.indexOf(seq.charAt(seq.length-1)) !== -1) {
		if (!this.vt100Warning) {
			this.decaf.debugString('Notice: This display handler only provides a subset of VT100, and doesn\'t handle cursor movement commands');
			this.vt100warning = true;
		}
	} else {
		this.decaf.debugString(`Unhandled ANSI Sequence: ESC [${seq}`);
	}
};

/** Write a formatting tag to the buffer */
Display.prototype.outColor = function(closing, ret) {
	let f = this.c_fg,
		b = this.c_bg,
		s = this.state
		opt = this.decaf.options.set_display;
	const classes = [];
	if (s & BRIGHT && f < 8) {
		f += 8;
	}
	
	if (s & ITALIC) { classes.push('italic'); }
	if (s & BLINK) { classes.push('blink'); } 
	if (s & UNDERLINE) { classes.push('underline'); }
	if (s & DBLUNDER) { classes.push('doubleunderline'); }
	if (s & FAINT) { classes.push('faint'); }
	if (s & STRIKE) { classes.push('strike'); }
	if (s & NEGATIVE) {
		b = f;
		f = this.c_bg;
	}
	if (this.c_fnt !== 0) { classes.push(`${opt.fntclass}${this.c_fnt}`); }
	if (f !== 7) { classes.push(`${opt.fgclass}${f}`); }
	if (f !== 0) { classes.push(`${opt.bgclass}${b}`); }
	const out = `${(closing !== false) ? '<span>' : ''}<span class='${classes.join(' ')}'>`;
	if (ret === true) { return out; }
	this.outbuf.push(out);
};

/** Append a message to the display's output. This is always displayed on a new
 *  line with a special class to allow for highlighting.
 * @param {String} text      The text to display.
 * @param {String} className The class name for the message's container.
 * @param {boolean} needLine If this is false, the message won't be forced onto
 *    a new line. */
Display.prototype.message = function(text, className, needLine) {
	if (className === undefined) { className = 'message'; }
	const span = document.createElement('span');
	if (this.needline && (needLine !== false)) { span.innerHTML = '<br>'; }
	this.needline = false;
	span.innerHTML += `${text.replace(/ ( +)/g, (m) => {return ` ${'&nbsp;'.repeat(m.length-1)}`;})}<br>`;
	this.shouldScroll();
	this.display.appendChild(span);
	this.doScroll();
};

/** Determine if we should be scrolling to the bottom of the output, and do so
	after a short delay if we should. Otherwise, display an element letting the
	user know they have have content to read if they scroll down. */
Display.prototype.shouldScroll = function(addTarget) {
	if (this.willScroll !== undefined || this._display.style.overflowY === 'undefined') {
		return;
	}
	this.willScroll = (this._display.scrollTop + 1) >= (this._display.scrollHeight - this._display.offsetHeight);
	// If we aren't scrolling, and the element isn't there, then add our scroll helper
	if (addTarget !== false && this.willScroll === false && !this.scrollTarget) {
		const st = document.createElement('hr');
		st.className = 'scroll-point';
		this.scrollTarget = st;
		this.display.appendChild(st);
		if (this.ui && this.ui.showScrollButton) {
			this.ui.showScrollButton();
		}
	}
};

/** Scroll the pane if we should */
Display.prototype.doScroll = function() {
	clearTimeout(this.scrollTime);
	const d = this;
	if (this.willScroll) {
		this.scrollTime = setTimeout(function() {
			if (d.scrollTarget) {
				d.scrollTarget.parentNode.removeChild(d.scrollTarget);
				d.scrollTarget = undefined;
			}
			d._display.setAttribute('aria-busy', false);
			d.scroll();
			d.willScroll = undefined;
		}, 5);
	} else {
		this.scrollTime = setTimeout(function() {
			d._display.setAttribute('aria-busy', false);
			d.willScroll = undefined;
		}, 5);
	}
};

/** Scroll to the start of new content marked by scrollTarget. */
Display.prototype.scrollNew = function() {
	if (!this.scrollTarget) {
		return;
	}
	if (this.scrollTarget.offsetTop > this._display.scrollTop) {
		this._display.scrollTop = this.scrollTarget.offsetTop;
	} else {
		this.scroll(); // Scroll to end
	}
};

/** Scroll to the bottom of the available output. Internal use. */
Display.prototype.scroll = function() {
	if (this._display.style.overflowY == 'hidden') {
		return;
	}
	this._display.scrollTop = this._display.scrollHeight;
};

/** If we've scrolled to the end, kill the scroll helper. */
Display.prototype.onScroll = function() {
	if ((this.scrollTarget === undefined) || !(this._display.scrollTop >= (this._display.scrollHeight - this._display.offsetHeight))) {
		return;
	}
	if (this.scrollTarget) {
		this.scrollTarget.parentNode.removeChild(this.scrollTarget);
		this.scrollTarget = undefined;
	}
	if (this.ui && this.ui.hideScrollButton) {
		this.ui.hideScrollButton();
	}
};

/** Scroll up a page. */
Display.prototype.scrollUp = function() {
	let top = this._display.scrollTop - this._display.clientHeight;
	if (top < 0) {
		top = 0;
	}
	this._display.scrollTop = top;
};

/** Scroll down a page. */
Display.prototype.scrollDown = function() {
	let top = this._display.scrollTop + this._display.clientHeight;
	this._display.scrollTop = top;
};

// MXP tags
/* These appear to be unused
Display.prototype.tags = {
	'VAR'        : {
		'default'    : true,
		'secure'    : true,
		'want'        : true,
		'open_tag'    : '',
		'close_tag'    : '',
		'arg_order'    : ['name','desc','private','publish','delete','add','remove'],
		'arguments'    : {
			'name'        : '',
			'desc'        : '',
			'private'    : false,
			'publish'    : true,
			'delete'    : false,
			'add'        : true,
			'remove'    : false },
		'handler'    : function() { }
	},
	
	'B'            : {
		'default'    : true,
		'secure'    : false,
		'want'        : false,
		'open_tag'    : '<b class="mxp">',
		'close_tag'    : '</b>'
	},
	'BOLD'        : 'B',
	'STRONG'    : 'B',
	
	'I'            : {
		'default'    : true,
		'secure'    : false,
		'want'        : false,
		'open_tag'    : '<i class="mxp">',
		'close_tag'    : '</i>'
	},
	'ITALIC'    : 'I',
	'EM'        : 'I',
	
	'U'            : {
		'default'    : true,
		'secure'    : false,
		'want'        : false,
		'open_tag'    : '<u class="mxp">',
		'close_tag'    : '</u>'
	},
	'UNDERLINE'    : 'U',
	
	'S'            : {
		'default'    : true,
		'secure'    : false,
		'want'        : false,
		'open_tag'    : '<s class="mxp">',
		'close_tag'    : '</s>'
	},
	'STRIKEOUT'    : 'S',
	
	'COLOR'        : {
		'default'    : true,
		'secure'    : false,
		'want'        : false,
		'open_tag'    : '<span class="mxp mxp-color" style="color:&fore;;background-color:&back;">',
		'close_tag'    : '</span>',
		'arg_order'    : ['fore','back'],
		'arguments'    : {
			'fore'        : 'inherit',
			'back'        : 'inherit'
		}
	},
	'C'            : 'COLOR',
	
	'HIGH'        : {
		'default'    : true,
		'secure'    : false,
		'want'        : true
	}
}*/

// Expose as DecafMUD display plugin
DecafMUD.plugins.Display.standard = Display;
})(DecafMUD);