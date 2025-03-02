/**
 * Copyright (c) 2014 The xterm.js authors. All rights reserved.
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * @license MIT
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 *   The original design remains. The terminal itself
 *   has been extended to include xterm CSI codes, among
 *   other features.
 *
 * Terminal Emulation References:
 *   http://vt100.net/
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.txt
 *   http://invisible-island.net/xterm/ctlseqs/ctlseqs.html
 *   http://invisible-island.net/vttest/
 *   http://www.inwap.com/pdp10/ansicode.txt
 *   http://linux.die.net/man/4/console_codes
 *   http://linux.die.net/man/7/urxvt
 */

import { ICompositionHelper, ITerminal, IBrowser, CustomKeyEventHandler, IViewport, ILinkifier2, CharacterJoinerHandler, IBufferRange, IBufferElementProvider } from 'browser/Types';
import { IRenderer } from 'browser/renderer/shared/Types';
import { CompositionHelper } from 'browser/input/CompositionHelper';
import { Viewport } from 'browser/Viewport';
import { rightClickHandler, moveTextAreaUnderMouseCursor, handlePasteEvent, copyHandler, paste } from 'browser/Clipboard';
import { C0, C1_ESCAPED } from 'common/data/EscapeSequences';
import { WindowsOptionsReportType } from '../common/InputHandler';
import { SelectionService } from 'browser/services/SelectionService';
import * as Browser from 'common/Platform';
import { addDisposableDomListener } from 'browser/Lifecycle';
import * as Strings from 'browser/LocalizableStrings';
import { AccessibilityManager } from './AccessibilityManager';
import { AccessibleBuffer } from './AccessibleBuffer';
import { ITheme, IMarker, IDisposable, ILinkProvider, IDecorationOptions, IDecoration } from 'xterm';
import { DomRenderer } from 'browser/renderer/dom/DomRenderer';
import { KeyboardResultType, CoreMouseEventType, CoreMouseButton, CoreMouseAction, ITerminalOptions, ScrollSource, IColorEvent, ColorIndex, ColorRequestType } from 'common/Types';
import { evaluateKeyboardEvent } from 'common/input/Keyboard';
import { EventEmitter, IEvent, forwardEvent } from 'common/EventEmitter';
import { DEFAULT_ATTR_DATA } from 'common/buffer/BufferLine';
import { RenderService } from 'browser/services/RenderService';
import { ICharSizeService, IRenderService, IMouseService, ISelectionService, ICoreBrowserService, ICharacterJoinerService, IThemeService } from 'browser/services/Services';
import { CharSizeService } from 'browser/services/CharSizeService';
import { IBuffer } from 'common/buffer/Types';
import { MouseService } from 'browser/services/MouseService';
import { Linkifier2 } from 'browser/Linkifier2';
import { CoreBrowserService } from 'browser/services/CoreBrowserService';
import { CoreTerminal } from 'common/CoreTerminal';
import { color, rgba } from 'common/Color';
import { CharacterJoinerService } from 'browser/services/CharacterJoinerService';
import { toRgbString } from 'common/input/XParseColor';
import { BufferDecorationRenderer } from 'browser/decorations/BufferDecorationRenderer';
import { OverviewRulerRenderer } from 'browser/decorations/OverviewRulerRenderer';
import { DecorationService } from 'common/services/DecorationService';
import { IDecorationService } from 'common/services/Services';
import { OscLinkProvider } from 'browser/OscLinkProvider';
import { toDisposable } from 'common/Lifecycle';
import { ThemeService } from 'browser/services/ThemeService';

// Let it work inside Node.js for automated testing purposes.
const document: Document = (typeof window !== 'undefined') ? window.document : null as any;

export class Terminal extends CoreTerminal implements ITerminal {
  public textarea: HTMLTextAreaElement | undefined;
  public element: HTMLElement | undefined;
  public screenElement: HTMLElement | undefined;

  private _document: Document | undefined;
  private _viewportScrollArea: HTMLElement | undefined;
  private _viewportElement: HTMLElement | undefined;
  private _helperContainer: HTMLElement | undefined;
  private _compositionView: HTMLElement | undefined;
  private _accessibleBuffer: AccessibleBuffer | undefined;

  private _overviewRulerRenderer: OverviewRulerRenderer | undefined;

  // private _visualBellTimer: number;

  public browser: IBrowser = Browser as any;

  private _customKeyEventHandler: CustomKeyEventHandler | undefined;

  // browser services
  private _decorationService: DecorationService;
  private _charSizeService: ICharSizeService | undefined;
  private _coreBrowserService: ICoreBrowserService | undefined;
  private _mouseService: IMouseService | undefined;
  private _renderService: IRenderService | undefined;
  private _themeService: IThemeService | undefined;
  private _characterJoinerService: ICharacterJoinerService | undefined;
  private _selectionService: ISelectionService | undefined;

  /**
   * Records whether the keydown event has already been handled and triggered a data event, if so
   * the keypress event should not trigger a data event but should still print to the textarea so
   * screen readers will announce it.
   */
  private _keyDownHandled: boolean = false;

  /**
   * Records whether a keydown event has occured since the last keyup event, i.e. whether a key
   * is currently "pressed".
   */
  private _keyDownSeen: boolean = false;

  /**
   * Records whether the keypress event has already been handled and triggered a data event, if so
   * the input event should not trigger a data event but should still print to the textarea so
   * screen readers will announce it.
   */
  private _keyPressHandled: boolean = false;

  /**
   * Records whether there has been a keydown event for a dead key without a corresponding keydown
   * event for the composed/alternative character. If we cancel the keydown event for the dead key,
   * no events will be emitted for the final character.
   */
  private _unprocessedDeadKey: boolean = false;

  private _activeMouseEvents: CoreMouseEventType = CoreMouseEventType.NONE;

  public linkifier2: ILinkifier2;
  public viewport: IViewport | undefined;
  private _compositionHelper: ICompositionHelper | undefined;
  private _accessibilityManager: AccessibilityManager | undefined;

  private readonly _onCursorMove = this.register(new EventEmitter<void>());
  public readonly onCursorMove = this._onCursorMove.event;
  private readonly _onKey = this.register(new EventEmitter<{ key: string, domEvent: KeyboardEvent }>());
  public readonly onKey = this._onKey.event;
  private readonly _onRender = this.register(new EventEmitter<{ start: number, end: number }>());
  public readonly onRender = this._onRender.event;
  private readonly _onSelectionChange = this.register(new EventEmitter<void>());
  public readonly onSelectionChange = this._onSelectionChange.event;
  private readonly _onTitleChange = this.register(new EventEmitter<string>());
  public readonly onTitleChange = this._onTitleChange.event;
  private readonly _onBell = this.register(new EventEmitter<void>());
  public readonly onBell = this._onBell.event;

  private _onFocus = this.register(new EventEmitter<void>());
  public get onFocus(): IEvent<void> { return this._onFocus.event; }
  private _onBlur = this.register(new EventEmitter<void>());
  public get onBlur(): IEvent<void> { return this._onBlur.event; }
  private _onA11yCharEmitter = this.register(new EventEmitter<string>());
  public get onA11yChar(): IEvent<string> { return this._onA11yCharEmitter.event; }
  private _onA11yTabEmitter = this.register(new EventEmitter<number>());
  public get onA11yTab(): IEvent<number> { return this._onA11yTabEmitter.event; }
  private _onWillOpen = this.register(new EventEmitter<HTMLElement>());
  public get onWillOpen(): IEvent<HTMLElement> { return this._onWillOpen.event; }

  /**
   * Creates a new `Terminal` object.
   *
   * @param options An object containing a set of options, the available options are:
   *   - `cursorBlink` (boolean): Whether the terminal cursor blinks
   *   - `cols` (number): The number of columns of the terminal (horizontal size)
   *   - `rows` (number): The number of rows of the terminal (vertical size)
   *
   * @public
   * @class Xterm Xterm
   * @alias module:xterm/src/xterm
   */
  constructor(
    options: Partial<ITerminalOptions> = {}
  ) {
    super(options);

    this._setup();

    this.linkifier2 = this.register(this._instantiationService.createInstance(Linkifier2));
    this.linkifier2.registerLinkProvider(this._instantiationService.createInstance(OscLinkProvider));
    this._decorationService = this._instantiationService.createInstance(DecorationService);
    this._instantiationService.setService(IDecorationService, this._decorationService);

    // Setup InputHandler listeners
    this.register(this._inputHandler.onRequestBell(() => this._onBell.fire()));
    this.register(this._inputHandler.onRequestRefreshRows((start, end) => this.refresh(start, end)));
    this.register(this._inputHandler.onRequestSendFocus(() => this._reportFocus()));
    this.register(this._inputHandler.onRequestReset(() => this.reset()));
    this.register(this._inputHandler.onRequestWindowsOptionsReport(type => this._reportWindowsOptions(type)));
    this.register(this._inputHandler.onColor((event) => this._handleColorEvent(event)));
    this.register(forwardEvent(this._inputHandler.onCursorMove, this._onCursorMove));
    this.register(forwardEvent(this._inputHandler.onTitleChange, this._onTitleChange));
    this.register(forwardEvent(this._inputHandler.onA11yChar, this._onA11yCharEmitter));
    this.register(forwardEvent(this._inputHandler.onA11yTab, this._onA11yTabEmitter));

    // Setup listeners
    this.register(this._bufferService.onResize(e => this._afterResize(e.cols, e.rows)));

    this.register(toDisposable(() => {
      this._customKeyEventHandler = undefined;
      this.element?.parentNode?.removeChild(this.element);
    }));
  }

  public registerBufferElementProvider(bufferProvider: IBufferElementProvider): IDisposable {
    if (!this._accessibleBuffer) {
      throw new Error ('Cannot register buffer element provider when terminal has not been opened yet');
    }
    return this._accessibleBuffer.registerBufferElementProvider(bufferProvider);
  }

  /**
   * Handle color event from inputhandler for OSC 4|104 | 10|110 | 11|111 | 12|112.
   * An event from OSC 4|104 may contain multiple set or report requests, and multiple
   * or none restore requests (resetting all),
   * while an event from OSC 10|110 | 11|111 | 12|112 always contains a single request.
   */
  private _handleColorEvent(event: IColorEvent): void {
    if (!this._themeService) return;
    for (const req of event) {
      let acc: 'foreground' | 'background' | 'cursor' | 'ansi';
      let ident = '';
      switch (req.index) {
        case ColorIndex.FOREGROUND: // OSC 10 | 110
          acc = 'foreground';
          ident = '10';
          break;
        case ColorIndex.BACKGROUND: // OSC 11 | 111
          acc = 'background';
          ident = '11';
          break;
        case ColorIndex.CURSOR: // OSC 12 | 112
          acc = 'cursor';
          ident = '12';
          break;
        default: // OSC 4 | 104
          // we can skip the [0..255] range check here (already done in inputhandler)
          acc = 'ansi';
          ident = '4;' + req.index;
      }
      switch (req.type) {
        case ColorRequestType.REPORT:
          const channels = color.toColorRGB(acc === 'ansi'
            ? this._themeService.colors.ansi[req.index]
            : this._themeService.colors[acc]);
          this.coreService.triggerDataEvent(`${C0.ESC}]${ident};${toRgbString(channels)}${C1_ESCAPED.ST}`);
          break;
        case ColorRequestType.SET:
          if (acc === 'ansi') {
            this._themeService.modifyColors(colors => colors.ansi[req.index] = rgba.toColor(...req.color));
          } else {
            const narrowedAcc = acc;
            this._themeService.modifyColors(colors => colors[narrowedAcc] = rgba.toColor(...req.color));
          }
          break;
        case ColorRequestType.RESTORE:
          this._themeService.restoreColor(req.index);
          break;
      }
    }
  }

  protected _setup(): void {
    super._setup();

    this._customKeyEventHandler = undefined;
  }

  /**
   * Convenience property to active buffer.
   */
  public get buffer(): IBuffer {
    return this.buffers.active;
  }

  /**
   * Focus the terminal. Delegates focus handling to the terminal's DOM element.
   */
  public focus(): void {
    if (this.textarea) {
      this.textarea.focus({ preventScroll: true });
    }
  }

  private _handleScreenReaderModeOptionChange(value: boolean): void {
    if (value) {
      if (!this._accessibilityManager && this._renderService) {
        this._accessibilityManager = this._instantiationService.createInstance(AccessibilityManager, this);
      }
    } else {
      this._accessibilityManager?.dispose();
      this._accessibilityManager = undefined;
    }
  }

  /**
   * Binds the desired focus behavior on a given terminal object.
   */
  private _handleTextAreaFocus(ev: KeyboardEvent): void {
    if (this.coreService.decPrivateModes.sendFocus) {
      this.coreService.triggerDataEvent(C0.ESC + '[I');
    }
    this.updateCursorStyle(ev);
    this.element!.classList.add('focus');
    this._showCursor();
    this._onFocus.fire();
  }

  /**
   * Blur the terminal, calling the blur function on the terminal's underlying
   * textarea.
   */
  public blur(): void {
    return this.textarea?.blur();
  }

  /**
   * Binds the desired blur behavior on a given terminal object.
   */
  private _handleTextAreaBlur(): void {
    // Text can safely be removed on blur. Doing it earlier could interfere with
    // screen readers reading it out.
    this.textarea!.value = '';
    this.refresh(this.buffer.y, this.buffer.y);
    if (this.coreService.decPrivateModes.sendFocus) {
      this.coreService.triggerDataEvent(C0.ESC + '[O');
    }
    this.element!.classList.remove('focus');
    this._onBlur.fire();
  }

  private _syncTextArea(): void {
    if (!this.textarea || !this.buffer.isCursorInViewport || this._compositionHelper!.isComposing || !this._renderService) {
      return;
    }
    const cursorY = this.buffer.ybase + this.buffer.y;
    const bufferLine = this.buffer.lines.get(cursorY);
    if (!bufferLine) {
      return;
    }
    const cursorX = Math.min(this.buffer.x, this.cols - 1);
    const cellHeight = this._renderService.dimensions.css.cell.height;
    const width = bufferLine.getWidth(cursorX);
    const cellWidth = this._renderService.dimensions.css.cell.width * width;
    const cursorTop = this.buffer.y * this._renderService.dimensions.css.cell.height;
    const cursorLeft = cursorX * this._renderService.dimensions.css.cell.width;

    // Sync the textarea to the exact position of the composition view so the IME knows where the
    // text is.
    this.textarea.style.left = cursorLeft + 'px';
    this.textarea.style.top = cursorTop + 'px';
    this.textarea.style.width = cellWidth + 'px';
    this.textarea.style.height = cellHeight + 'px';
    this.textarea.style.lineHeight = cellHeight + 'px';
    this.textarea.style.zIndex = '-5';
  }

  /**
   * Initialize default behavior
   */
  private _initGlobal(): void {
    this._bindKeys();

    // Bind clipboard functionality
    this.register(addDisposableDomListener(this.element!, 'copy', (event: ClipboardEvent) => {
      // If mouse events are active it means the selection manager is disabled and
      // copy should be handled by the host program.
      if (!this.hasSelection()) {
        return;
      }
      copyHandler(event, this._selectionService!);
    }));
    const pasteHandlerWrapper = (event: ClipboardEvent): void => handlePasteEvent(event, this.textarea!, this.coreService);
    this.register(addDisposableDomListener(this.textarea!, 'paste', pasteHandlerWrapper));
    this.register(addDisposableDomListener(this.element!, 'paste', pasteHandlerWrapper));

    // Handle right click context menus
    if (Browser.isFirefox) {
      // Firefox doesn't appear to fire the contextmenu event on right click
      this.register(addDisposableDomListener(this.element!, 'mousedown', (event: MouseEvent) => {
        if (event.button === 2) {
          rightClickHandler(event, this.textarea!, this.screenElement!, this._selectionService!, this.options.rightClickSelectsWord);
        }
      }));
    } else {
      this.register(addDisposableDomListener(this.element!, 'contextmenu', (event: MouseEvent) => {
        rightClickHandler(event, this.textarea!, this.screenElement!, this._selectionService!, this.options.rightClickSelectsWord);
      }));
    }

    // Move the textarea under the cursor when middle clicking on Linux to ensure
    // middle click to paste selection works. This only appears to work in Chrome
    // at the time is writing.
    if (Browser.isLinux) {
      // Use auxclick event over mousedown the latter doesn't seem to work. Note
      // that the regular click event doesn't fire for the middle mouse button.
      this.register(addDisposableDomListener(this.element!, 'auxclick', (event: MouseEvent) => {
        if (event.button === 1) {
          moveTextAreaUnderMouseCursor(event, this.textarea!, this.screenElement!);
        }
      }));
    }
  }

  /**
   * Apply key handling to the terminal
   */
  private _bindKeys(): void {
    this.register(addDisposableDomListener(this.textarea!, 'keyup', (ev: KeyboardEvent) => this._keyUp(ev), true));
    this.register(addDisposableDomListener(this.textarea!, 'keydown', (ev: KeyboardEvent) => this._keyDown(ev), true));
    this.register(addDisposableDomListener(this.textarea!, 'keypress', (ev: KeyboardEvent) => this._keyPress(ev), true));
    this.register(addDisposableDomListener(this.textarea!, 'compositionstart', () => this._compositionHelper!.compositionstart()));
    this.register(addDisposableDomListener(this.textarea!, 'compositionupdate', (e: CompositionEvent) => this._compositionHelper!.compositionupdate(e)));
    this.register(addDisposableDomListener(this.textarea!, 'compositionend', () => this._compositionHelper!.compositionend()));
    this.register(addDisposableDomListener(this.textarea!, 'input', (ev: InputEvent) => this._inputEvent(ev), true));
    this.register(this.onRender(() => this._compositionHelper!.updateCompositionElements()));
  }

  /**
   * Opens the terminal within an element.
   *
   * @param parent The element to create the terminal within.
   */
  public open(parent: HTMLElement): void {
    if (!parent) {
      throw new Error('Terminal requires a parent element.');
    }

    if (!parent.isConnected) {
      this._logService.debug('Terminal.open was called on an element that was not attached to the DOM');
    }

    this._document = parent.ownerDocument!;

    // Create main element container
    this.element = this._document.createElement('div');
    this.element.dir = 'ltr';   // xterm.css assumes LTR
    this.element.classList.add('terminal');
    this.element.classList.add('xterm');
    parent.appendChild(this.element);

    // Performance: Use a document fragment to build the terminal
    // viewport and helper elements detached from the DOM
    const fragment = document.createDocumentFragment();
    this._viewportElement = document.createElement('div');
    this._viewportElement.classList.add('xterm-viewport');
    fragment.appendChild(this._viewportElement);

    this._viewportScrollArea = document.createElement('div');
    this._viewportScrollArea.classList.add('xterm-scroll-area');
    this._viewportElement.appendChild(this._viewportScrollArea);

    this.screenElement = document.createElement('div');
    this.screenElement.classList.add('xterm-screen');
    // Create the container that will hold helpers like the textarea for
    // capturing DOM Events. Then produce the helpers.
    this._helperContainer = document.createElement('div');
    this._helperContainer.classList.add('xterm-helpers');
    this.screenElement.appendChild(this._helperContainer);
    fragment.appendChild(this.screenElement);

    this.textarea = document.createElement('textarea');
    this.textarea.classList.add('xterm-helper-textarea');
    this.textarea.setAttribute('aria-label', Strings.promptLabel);
    if (!Browser.isChromeOS) {
      // ChromeVox on ChromeOS does not like this. See
      // https://issuetracker.google.com/issues/260170397
      this.textarea.setAttribute('aria-multiline', 'false');
    }
    this.textarea.setAttribute('autocorrect', 'off');
    this.textarea.setAttribute('autocapitalize', 'off');
    this.textarea.setAttribute('spellcheck', 'false');
    this.textarea.tabIndex = 0;

    // Register the core browser service before the generic textarea handlers are registered so it
    // handles them first. Otherwise the renderers may use the wrong focus state.
    this._coreBrowserService = this._instantiationService.createInstance(CoreBrowserService, this.textarea, this._document.defaultView ?? window);
    this._instantiationService.setService(ICoreBrowserService, this._coreBrowserService);

    this.register(addDisposableDomListener(this.textarea, 'focus', (ev: KeyboardEvent) => this._handleTextAreaFocus(ev)));
    this.register(addDisposableDomListener(this.textarea, 'blur', () => this._handleTextAreaBlur()));
    this._helperContainer.appendChild(this.textarea);


    this._charSizeService = this._instantiationService.createInstance(CharSizeService, this._document, this._helperContainer);
    this._instantiationService.setService(ICharSizeService, this._charSizeService);

    this._themeService = this._instantiationService.createInstance(ThemeService);
    this._instantiationService.setService(IThemeService, this._themeService);

    this._characterJoinerService = this._instantiationService.createInstance(CharacterJoinerService);
    this._instantiationService.setService(ICharacterJoinerService, this._characterJoinerService);

    this._renderService = this.register(this._instantiationService.createInstance(RenderService, this.rows, this.screenElement));
    this._instantiationService.setService(IRenderService, this._renderService);
    this.register(this._renderService.onRenderedViewportChange(e => this._onRender.fire(e)));
    this.onResize(e => this._renderService!.resize(e.cols, e.rows));

    this._compositionView = document.createElement('div');
    this._compositionView.classList.add('composition-view');
    this._compositionHelper = this._instantiationService.createInstance(CompositionHelper, this.textarea, this._compositionView);
    this._helperContainer.appendChild(this._compositionView);

    // Performance: Add viewport and helper elements from the fragment
    this.element.appendChild(fragment);

    try {
      this._onWillOpen.fire(this.element);
    }
    catch { /* fails to load addon for some reason */ }
    if (!this._renderService.hasRenderer()) {
      this._renderService.setRenderer(this._createRenderer());
    }

    this._mouseService = this._instantiationService.createInstance(MouseService);
    this._instantiationService.setService(IMouseService, this._mouseService);

    this.viewport = this._instantiationService.createInstance(Viewport,
      (amount: number) => this.scrollLines(amount, true, ScrollSource.VIEWPORT),
      this._viewportElement,
      this._viewportScrollArea
    );
    this.register(this._inputHandler.onRequestSyncScrollBar(() => this.viewport!.syncScrollArea()));
    this.register(this.viewport);

    this.register(this.onCursorMove(() => {
      this._renderService!.handleCursorMove();
      this._syncTextArea();
    }));
    this.register(this.onResize(() => this._renderService!.handleResize(this.cols, this.rows)));
    this.register(this.onBlur(() => this._renderService!.handleBlur()));
    this.register(this.onFocus(() => this._renderService!.handleFocus()));
    this.register(this._renderService.onDimensionsChange(() => this.viewport!.syncScrollArea()));

    this._selectionService = this.register(this._instantiationService.createInstance(SelectionService,
      this.element,
      this.screenElement,
      this.linkifier2
    ));
    this._instantiationService.setService(ISelectionService, this._selectionService);
    this.register(this._selectionService.onRequestScrollLines(e => this.scrollLines(e.amount, e.suppressScrollEvent)));
    this.register(this._selectionService.onSelectionChange(() => this._onSelectionChange.fire()));
    this.register(this._selectionService.onRequestRedraw(e => this._renderService!.handleSelectionChanged(e.start, e.end, e.columnSelectMode)));
    this.register(this._selectionService.onLinuxMouseSelection(text => {
      // If there's a new selection, put it into the textarea, focus and select it
      // in order to register it as a selection on the OS. This event is fired
      // only on Linux to enable middle click to paste selection.
      this.textarea!.value = text;
      this.textarea!.focus();
      this.textarea!.select();
    }));
    this.register(this._onScroll.event(ev => {
      this.viewport!.syncScrollArea();
      this._selectionService!.refresh();
    }));
    this.register(addDisposableDomListener(this._viewportElement, 'scroll', () => this._selectionService!.refresh()));

    this.linkifier2.attachToDom(this.screenElement, this._mouseService, this._renderService);
    this.register(this._instantiationService.createInstance(BufferDecorationRenderer, this.screenElement));
    this.register(addDisposableDomListener(this.element, 'mousedown', (e: MouseEvent) => this._selectionService!.handleMouseDown(e)));

    // apply mouse event classes set by escape codes before terminal was attached
    if (this.coreMouseService.areMouseEventsActive) {
      this._selectionService.disable();
      this.element.classList.add('enable-mouse-events');
    } else {
      this._selectionService.enable();
    }

    if (this.options.screenReaderMode) {
      // Note that this must be done *after* the renderer is created in order to
      // ensure the correct order of the dprchange event
      this._accessibilityManager = this._instantiationService.createInstance(AccessibilityManager, this);
    }
    this.register(this.optionsService.onSpecificOptionChange('screenReaderMode', e => this._handleScreenReaderModeOptionChange(e)));

    if (this.options.overviewRulerWidth) {
      this._overviewRulerRenderer = this.register(this._instantiationService.createInstance(OverviewRulerRenderer, this._viewportElement, this.screenElement));
    }
    this.optionsService.onSpecificOptionChange('overviewRulerWidth', value => {
      if (!this._overviewRulerRenderer && value && this._viewportElement && this.screenElement) {
        this._overviewRulerRenderer = this.register(this._instantiationService.createInstance(OverviewRulerRenderer, this._viewportElement, this.screenElement));
      }
    });
    // Measure the character size
    this._charSizeService.measure();

    // Setup loop that draws to screen
    this.refresh(0, this.rows - 1);

    // Initialize global actions that need to be taken on the document.
    this._initGlobal();

    // Listen for mouse events and translate
    // them into terminal mouse protocols.
    this.bindMouse();

    this._accessibleBuffer = this._instantiationService.createInstance(AccessibleBuffer, this);
  }

  private _createRenderer(): IRenderer {
    return this._instantiationService.createInstance(DomRenderer, this.element!, this.screenElement!, this._viewportElement!, this.linkifier2);
  }

  /**
   * Bind certain mouse events to the terminal.
   * By default only 3 button + wheel up/down is ativated. For higher buttons
   * no mouse report will be created. Typically the standard actions will be active.
   *
   * There are several reasons not to enable support for higher buttons/wheel:
   * - Button 4 and 5 are typically used for history back and forward navigation,
   *   there is no straight forward way to supress/intercept those standard actions.
   * - Support for higher buttons does not work in some platform/browser combinations.
   * - Left/right wheel was not tested.
   * - Emulators vary in mouse button support, typically only 3 buttons and
   *   wheel up/down work reliable.
   *
   * TODO: Move mouse event code into its own file.
   */
  public bindMouse(): void {
    const self = this;
    const el = this.element!;

    // send event to CoreMouseService
    function sendEvent(ev: MouseEvent | WheelEvent): boolean {
      // get mouse coordinates
      const pos = self._mouseService!.getMouseReportCoords(ev, self.screenElement!);
      if (!pos) {
        return false;
      }

      let but: CoreMouseButton;
      let action: CoreMouseAction | undefined;
      switch ((ev as any).overrideType || ev.type) {
        case 'mousemove':
          action = CoreMouseAction.MOVE;
          if (ev.buttons === undefined) {
            // buttons is not supported on macOS, try to get a value from button instead
            but = CoreMouseButton.NONE;
            if (ev.button !== undefined) {
              but = ev.button < 3 ? ev.button : CoreMouseButton.NONE;
            }
          } else {
            // according to MDN buttons only reports up to button 5 (AUX2)
            but = ev.buttons & 1 ? CoreMouseButton.LEFT :
              ev.buttons & 4 ? CoreMouseButton.MIDDLE :
                ev.buttons & 2 ? CoreMouseButton.RIGHT :
                  CoreMouseButton.NONE; // fallback to NONE
          }
          break;
        case 'mouseup':
          action = CoreMouseAction.UP;
          but = ev.button < 3 ? ev.button : CoreMouseButton.NONE;
          break;
        case 'mousedown':
          action = CoreMouseAction.DOWN;
          but = ev.button < 3 ? ev.button : CoreMouseButton.NONE;
          break;
        case 'wheel':
          const amount = self.viewport!.getLinesScrolled(ev as WheelEvent);

          if (amount === 0) {
            return false;
          }

          action = (ev as WheelEvent).deltaY < 0 ? CoreMouseAction.UP : CoreMouseAction.DOWN;
          but = CoreMouseButton.WHEEL;
          break;
        default:
          // dont handle other event types by accident
          return false;
      }

      // exit if we cannot determine valid button/action values
      // do nothing for higher buttons than wheel
      if (action === undefined || but === undefined || but > CoreMouseButton.WHEEL) {
        return false;
      }

      return self.coreMouseService.triggerMouseEvent({
        col: pos.col,
        row: pos.row,
        x: pos.x,
        y: pos.y,
        button: but,
        action,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey
      });
    }

    function mouseProtocolChangeHandler(events: CoreMouseEventType) {
      // apply global changes on events
      if (events) {
        if (self.optionsService.rawOptions.logLevel === 'debug') {
          self._logService.debug('Binding to mouse events:', self.coreMouseService.explainEvents(events));
        }
        self.element!.classList.add('enable-mouse-events');
        self._selectionService!.disable();
      } else {
        self._logService.debug('Unbinding from mouse events.');
        self.element!.classList.remove('enable-mouse-events');
        self._selectionService!.enable();
      }

      // add/remove handlers from requestedEvents

      if (!(events & CoreMouseEventType.MOVE)) {
        el.removeEventListener('mousemove', requestedEvents.mousemove!);
        requestedEvents.mousemove = null;
      } else if (!requestedEvents.mousemove) {
        el.addEventListener('mousemove', eventListeners.mousemove);
        requestedEvents.mousemove = eventListeners.mousemove;
      }

      if (!(events & CoreMouseEventType.WHEEL)) {
        el.removeEventListener('wheel', requestedEvents.wheel!);
        requestedEvents.wheel = null;
      } else if (!requestedEvents.wheel) {
        el.addEventListener('wheel', eventListeners.wheel, { passive: false });
        requestedEvents.wheel = eventListeners.wheel;
      }

      if (!(events & CoreMouseEventType.UP)) {
        self._document!.removeEventListener('mouseup', requestedEvents.mouseup!);
        requestedEvents.mouseup = null;
      } else if (!requestedEvents.mouseup) {
        requestedEvents.mouseup = eventListeners.mouseup;
      }

      if (!(events & CoreMouseEventType.DRAG)) {
        self._document!.removeEventListener('mousemove', requestedEvents.mousedrag!);
        requestedEvents.mousedrag = null;
      } else if (!requestedEvents.mousedrag) {
        requestedEvents.mousedrag = eventListeners.mousedrag;
      }
    }

    /**
     * Event listener state handling.
     * We listen to the onProtocolChange event of CoreMouseService and put
     * requested listeners in `requestedEvents`. With this the listeners
     * have all bits to do the event listener juggling.
     * Note: 'mousedown' currently is "always on" and not managed
     * by onProtocolChange.
     */
    const requestedEvents: { [key: string]: ((ev: Event) => void) | null } = {
      mouseup: null,
      wheel: null,
      mousedrag: null,
      mousemove: null
    };
    const eventListeners: { [key: string]: (ev: any) => void | boolean } = {
      mouseup: (ev: MouseEvent) => {
        sendEvent(ev);
        if (!ev.buttons) {
          // if no other button is held remove global handlers
          this._document!.removeEventListener('mouseup', requestedEvents.mouseup!);
          if (requestedEvents.mousedrag) {
            this._document!.removeEventListener('mousemove', requestedEvents.mousedrag);
          }
        }
        return this.cancel(ev);
      },
      wheel: (ev: WheelEvent) => {
        sendEvent(ev);
        return this.cancel(ev, true);
      },
      mousedrag: (ev: MouseEvent) => {
        // deal only with move while a button is held
        if (ev.buttons) {
          sendEvent(ev);
        }
      },
      mousemove: (ev: MouseEvent) => {
        // deal only with move without any button
        if (!ev.buttons) {
          sendEvent(ev);
        }
      }
    };
    this.register(this.coreMouseService.onProtocolChange((events) => {
      this._activeMouseEvents = events;
      if (!this.optionsService.rawOptions.allowMouseReporting) {
        events = CoreMouseEventType.NONE;
      }
      mouseProtocolChangeHandler(events);
    }));
    this.register(this.optionsService.onOptionChange(() => {
      let events = this.optionsService.rawOptions.allowMouseReporting ?
        this._activeMouseEvents : CoreMouseEventType.NONE;
      mouseProtocolChangeHandler(events);
    }));
    // force initial onProtocolChange so we dont miss early mouse requests
    this.coreMouseService.activeProtocol = this.coreMouseService.activeProtocol;

    /**
     * "Always on" event listeners.
     */
    this.register(addDisposableDomListener(el, 'mousedown', (ev: MouseEvent) => {
      ev.preventDefault();
      if (this._accessibleBuffer?.isAccessibleBufferActive) {
        return;
      }
      this.focus();

      // Don't send the mouse button to the pty if mouse events are disabled or
      // if the selection manager is having selection forced (ie. a modifier is
      // held).
      if (!this.coreMouseService.areMouseEventsActive || this._selectionService!.shouldForceSelection(ev)) {
        return;
      }

      sendEvent(ev);

      // Register additional global handlers which should keep reporting outside
      // of the terminal element.
      // Note: Other emulators also do this for 'mousedown' while a button
      // is held, we currently limit 'mousedown' to the terminal only.
      if (requestedEvents.mouseup) {
        this._document!.addEventListener('mouseup', requestedEvents.mouseup);
      }
      if (requestedEvents.mousedrag) {
        this._document!.addEventListener('mousemove', requestedEvents.mousedrag);
      }

      return this.cancel(ev);
    }));

    this.register(addDisposableDomListener(el, 'wheel', (ev: WheelEvent) => {
      // do nothing, if app side handles wheel itself
      if (requestedEvents.wheel) return;

      if (!this.buffer.hasScrollback) {
        // Convert wheel events into up/down events when the buffer does not have scrollback, this
        // enables scrolling in apps hosted in the alt buffer such as vim or tmux.
        const amount = this.viewport!.getLinesScrolled(ev);

        // Do nothing if there's no vertical scroll
        if (amount === 0) {
          return;
        }

        if (this.optionsService.rawOptions.allowMouseReporting) {
          // Construct and send sequences
          const sequence = C0.ESC + (this.coreService.decPrivateModes.applicationCursorKeys ? 'O' : '[') + (ev.deltaY < 0 ? 'A' : 'B');
          let data = '';
          for (let i = 0; i < Math.abs(amount); i++) {
            data += sequence;
          }
          this.coreService.triggerDataEvent(data, true);
        }
        return this.cancel(ev, true);
      }

      // normal viewport scrolling
      // conditionally stop event, if the viewport still had rows to scroll within
      if (this.viewport!.handleWheel(ev)) {
        return this.cancel(ev);
      }
    }, { passive: false }));

    this.register(addDisposableDomListener(el, 'touchstart', (ev: TouchEvent) => {
      if (this.coreMouseService.areMouseEventsActive) return;
      this.viewport!.handleTouchStart(ev);
      return this.cancel(ev);
    }, { passive: true }));

    this.register(addDisposableDomListener(el, 'touchmove', (ev: TouchEvent) => {
      if (this.coreMouseService.areMouseEventsActive) return;
      if (!this.viewport!.handleTouchMove(ev)) {
        return this.cancel(ev);
      }
    }, { passive: false }));
  }


  /**
   * Tells the renderer to refresh terminal content between two rows (inclusive) at the next
   * opportunity.
   * @param start The row to start from (between 0 and this.rows - 1).
   * @param end The row to end at (between start and this.rows - 1).
   */
  public refresh(start: number, end: number): void {
    this._renderService?.refreshRows(start, end);
  }

  /**
   * Change the cursor style for different selection modes
   */
  public updateCursorStyle(ev: KeyboardEvent): void {
    if (this._selectionService?.shouldColumnSelect(ev)) {
      this.element!.classList.add('column-select');
    } else {
      this.element!.classList.remove('column-select');
    }
  }

  /**
   * Display the cursor element
   */
  private _showCursor(): void {
    if (!this.coreService.isCursorInitialized) {
      this.coreService.isCursorInitialized = true;
      this.refresh(this.buffer.y, this.buffer.y);
    }
  }

  public scrollLines(disp: number, suppressScrollEvent?: boolean, source = ScrollSource.TERMINAL): void {
    super.scrollLines(disp, suppressScrollEvent, source);
    this.refresh(0, this.rows - 1);
  }

  public paste(data: string): void {
    paste(data, this.textarea!, this.coreService);
  }

  /**
   * Attaches a custom key event handler which is run before keys are processed,
   * giving consumers of xterm.js ultimate control as to what keys should be
   * processed by the terminal and what keys should not.
   * @param customKeyEventHandler The custom KeyboardEvent handler to attach.
   * This is a function that takes a KeyboardEvent, allowing consumers to stop
   * propagation and/or prevent the default action. The function returns whether
   * the event should be processed by xterm.js.
   */
  public attachCustomKeyEventHandler(customKeyEventHandler: CustomKeyEventHandler): void {
    this._customKeyEventHandler = customKeyEventHandler;
  }

  public registerLinkProvider(linkProvider: ILinkProvider): IDisposable {
    return this.linkifier2.registerLinkProvider(linkProvider);
  }

  public registerCharacterJoiner(handler: CharacterJoinerHandler): number {
    if (!this._characterJoinerService) {
      throw new Error('Terminal must be opened first');
    }
    const joinerId = this._characterJoinerService.register(handler);
    this.refresh(0, this.rows - 1);
    return joinerId;
  }

  public deregisterCharacterJoiner(joinerId: number): void {
    if (!this._characterJoinerService) {
      throw new Error('Terminal must be opened first');
    }
    if (this._characterJoinerService.deregister(joinerId)) {
      this.refresh(0, this.rows - 1);
    }
  }

  public get markers(): IMarker[] {
    return this.buffer.markers;
  }

  public addMarker(cursorYOffset: number): IMarker | undefined {
    return this.buffer.addMarker(this.buffer.ybase + this.buffer.y + cursorYOffset);
  }

  public registerDecoration(decorationOptions: IDecorationOptions): IDecoration | undefined {
    return this._decorationService.registerDecoration(decorationOptions);
  }

  /**
   * Gets whether the terminal has an active selection.
   */
  public hasSelection(): boolean {
    return this._selectionService ? this._selectionService.hasSelection : false;
  }

  /**
   * Selects text within the terminal.
   * @param column The column the selection starts at..
   * @param row The row the selection starts at.
   * @param length The length of the selection.
   */
  public select(column: number, row: number, length: number): void {
    this._selectionService!.setSelection(column, row, length);
  }

  /**
   * Gets the terminal's current selection, this is useful for implementing copy
   * behavior outside of xterm.js.
   */
  public getSelection(): string {
    return this._selectionService ? this._selectionService.selectionText : '';
  }

  public getSelectionPosition(): IBufferRange | undefined {
    if (!this._selectionService || !this._selectionService.hasSelection) {
      return undefined;
    }

    return {
      start: {
        x: this._selectionService.selectionStart![0],
        y: this._selectionService.selectionStart![1]
      },
      end: {
        x: this._selectionService.selectionEnd![0],
        y: this._selectionService.selectionEnd![1]
      }
    };
  }

  /**
   * Clears the current terminal selection.
   */
  public clearSelection(): void {
    this._selectionService?.clearSelection();
  }

  /**
   * Selects all text within the terminal.
   */
  public selectAll(): void {
    this._selectionService?.selectAll();
  }

  public selectLines(start: number, end: number): void {
    this._selectionService?.selectLines(start, end);
  }

  /**
   * Handle a keydown [KeyboardEvent].
   *
   * [KeyboardEvent]: https://developer.mozilla.org/en-US/docs/DOM/KeyboardEvent
   */
  protected _keyDown(event: KeyboardEvent): boolean | undefined {
    this._keyDownHandled = false;
    this._keyDownSeen = true;

    if (this._customKeyEventHandler && this._customKeyEventHandler(event) === false) {
      return false;
    }

    // Ignore composing with Alt key on Mac when macOptionIsMeta is enabled
    const shouldIgnoreComposition = this.browser.isMac && this.options.macOptionIsMeta && event.altKey;

    if (!shouldIgnoreComposition && !this._compositionHelper!.keydown(event)) {
      if (this.options.scrollOnUserInput && this.buffer.ybase !== this.buffer.ydisp) {
        this._bufferService.scrollToBottom();
      }
      return false;
    }

    if (!shouldIgnoreComposition && (event.key === 'Dead' || event.key === 'AltGraph')) {
      this._unprocessedDeadKey = true;
    }

    const result = evaluateKeyboardEvent(event, this.coreService.decPrivateModes.applicationCursorKeys, this.browser.isMac, this.options.macOptionIsMeta);

    this.updateCursorStyle(event);

    if (result.type === KeyboardResultType.PAGE_DOWN || result.type === KeyboardResultType.PAGE_UP) {
      const scrollCount = this.rows - 1;
      this.scrollLines(result.type === KeyboardResultType.PAGE_UP ? -scrollCount : scrollCount);
      return this.cancel(event, true);
    }

    if (result.type === KeyboardResultType.SELECT_ALL) {
      this.selectAll();
    }

    if (this._isThirdLevelShift(this.browser, event)) {
      return true;
    }

    if (result.cancel) {
      // The event is canceled at the end already, is this necessary?
      this.cancel(event, true);
    }

    if (!result.key) {
      return true;
    }

    // HACK: Process A-Z in the keypress event to fix an issue with macOS IMEs where lower case
    // letters cannot be input while caps lock is on.
    if (event.key && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
      if (event.key.charCodeAt(0) >= 65 && event.key.charCodeAt(0) <= 90) {
        return true;
      }
    }

    if (this._unprocessedDeadKey) {
      this._unprocessedDeadKey = false;
      return true;
    }

    // If ctrl+c or enter is being sent, clear out the textarea. This is done so that screen readers
    // will announce deleted characters. This will not work 100% of the time but it should cover
    // most scenarios.
    if (result.key === C0.ETX || result.key === C0.CR) {
      this.textarea!.value = '';
    }

    this._onKey.fire({ key: result.key, domEvent: event });
    this._showCursor();
    this.coreService.triggerDataEvent(result.key, true);

    // Cancel events when not in screen reader mode so events don't get bubbled up and handled by
    // other listeners. When screen reader mode is enabled, we don't cancel them (unless ctrl or alt
    // is also depressed) so that the cursor textarea can be updated, which triggers the screen
    // reader to read it.
    if (!this.optionsService.rawOptions.screenReaderMode || event.altKey || event.ctrlKey) {
      return this.cancel(event, true);
    }

    this._keyDownHandled = true;
  }

  private _isThirdLevelShift(browser: IBrowser, ev: KeyboardEvent): boolean {
    const thirdLevelKey =
      (browser.isMac && !this.options.macOptionIsMeta && ev.altKey && !ev.ctrlKey && !ev.metaKey) ||
      (browser.isWindows && ev.altKey && ev.ctrlKey && !ev.metaKey) ||
      (browser.isWindows && ev.getModifierState('AltGraph'));

    if (ev.type === 'keypress') {
      return thirdLevelKey;
    }

    // Don't invoke for arrows, pageDown, home, backspace, etc. (on non-keypress events)
    return thirdLevelKey && (!ev.keyCode || ev.keyCode > 47);
  }

  protected _keyUp(ev: KeyboardEvent): void {
    this._keyDownSeen = false;

    if (this._customKeyEventHandler && this._customKeyEventHandler(ev) === false) {
      return;
    }

    if (!wasModifierKeyOnlyEvent(ev)) {
      this.focus();
    }

    this.updateCursorStyle(ev);
    this._keyPressHandled = false;
  }

  /**
   * Handle a keypress event.
   * Key Resources:
   *   - https://developer.mozilla.org/en-US/docs/DOM/KeyboardEvent
   * @param ev The keypress event to be handled.
   */
  protected _keyPress(ev: KeyboardEvent): boolean {
    let key;

    this._keyPressHandled = false;

    if (this._keyDownHandled) {
      return false;
    }

    if (this._customKeyEventHandler && this._customKeyEventHandler(ev) === false) {
      return false;
    }

    this.cancel(ev);

    if (ev.charCode) {
      key = ev.charCode;
    } else if (ev.which === null || ev.which === undefined) {
      key = ev.keyCode;
    } else if (ev.which !== 0 && ev.charCode !== 0) {
      key = ev.which;
    } else {
      return false;
    }

    if (!key || (
      (ev.altKey || ev.ctrlKey || ev.metaKey) && !this._isThirdLevelShift(this.browser, ev)
    )) {
      return false;
    }

    key = String.fromCharCode(key);

    this._onKey.fire({ key, domEvent: ev });
    this._showCursor();
    this.coreService.triggerDataEvent(key, true);

    this._keyPressHandled = true;

    // The key was handled so clear the dead key state, otherwise certain keystrokes like arrow
    // keys could be ignored
    this._unprocessedDeadKey = false;

    return true;
  }

  /**
   * Handle an input event.
   * Key Resources:
   *   - https://developer.mozilla.org/en-US/docs/Web/API/InputEvent
   * @param ev The input event to be handled.
   */
  protected _inputEvent(ev: InputEvent): boolean {
    // Only support emoji IMEs when screen reader mode is disabled as the event must bubble up to
    // support reading out character input which can doubling up input characters
    // Based on these event traces: https://github.com/xtermjs/xterm.js/issues/3679
    if (ev.data && ev.inputType === 'insertText' && (!ev.composed || !this._keyDownSeen) && !this.optionsService.rawOptions.screenReaderMode) {
      if (this._keyPressHandled) {
        return false;
      }

      // The key was handled so clear the dead key state, otherwise certain keystrokes like arrow
      // keys could be ignored
      this._unprocessedDeadKey = false;

      const text = ev.data;
      this.coreService.triggerDataEvent(text, true);

      this.cancel(ev);
      return true;
    }

    return false;
  }

  /**
   * Resizes the terminal.
   *
   * @param x The number of columns to resize to.
   * @param y The number of rows to resize to.
   */
  public resize(x: number, y: number): void {
    if (x === this.cols && y === this.rows) {
      // Check if we still need to measure the char size (fixes #785).
      if (this._charSizeService && !this._charSizeService.hasValidSize) {
        this._charSizeService.measure();
      }
      return;
    }

    super.resize(x, y);
  }

  private _afterResize(x: number, y: number): void {
    this._charSizeService?.measure();

    // Sync the scroll area to make sure scroll events don't fire and scroll the viewport to an
    // invalid location
    this.viewport?.syncScrollArea(true);
  }

  /**
   * Clear the entire buffer, making the prompt line the new first line.
   */
  public clear(): void {
    if (this.buffer.ybase === 0 && this.buffer.y === 0) {
      // Don't clear if it's already clear
      return;
    }
    this.buffer.clearAllMarkers();
    this.buffer.lines.set(0, this.buffer.lines.get(this.buffer.ybase + this.buffer.y)!);
    this.buffer.lines.length = 1;
    this.buffer.ydisp = 0;
    this.buffer.ybase = 0;
    this.buffer.y = 0;
    for (let i = 1; i < this.rows; i++) {
      this.buffer.lines.push(this.buffer.getBlankLine(DEFAULT_ATTR_DATA));
    }
    this.refresh(0, this.rows - 1);
    this._onScroll.fire({ position: this.buffer.ydisp, source: ScrollSource.TERMINAL });
  }

  /**
   * Reset terminal.
   * Note: Calling this directly from JS is synchronous but does not clear
   * input buffers and does not reset the parser, thus the terminal will
   * continue to apply pending input data.
   * If you need in band reset (synchronous with input data) consider
   * using DECSTR (soft reset, CSI ! p) or RIS instead (hard reset, ESC c).
   */
  public reset(): void {
    /**
     * Since _setup handles a full terminal creation, we have to carry forward
     * a few things that should not reset.
     */
    this.options.rows = this.rows;
    this.options.cols = this.cols;
    const customKeyEventHandler = this._customKeyEventHandler;

    this._setup();
    super.reset();
    this._selectionService?.reset();
    this._decorationService.reset();

    // reattach
    this._customKeyEventHandler = customKeyEventHandler;

    // do a full screen refresh
    this.refresh(0, this.rows - 1);
    this.viewport?.syncScrollArea();
  }

  public clearTextureAtlas(): void {
    this._renderService?.clearTextureAtlas();
  }

  private _reportFocus(): void {
    if (this.element?.classList.contains('focus')) {
      this.coreService.triggerDataEvent(C0.ESC + '[I');
    } else {
      this.coreService.triggerDataEvent(C0.ESC + '[O');
    }
  }

  private _reportWindowsOptions(type: WindowsOptionsReportType): void {
    if (!this._renderService) {
      return;
    }

    switch (type) {
      case WindowsOptionsReportType.GET_WIN_SIZE_PIXELS:
        const canvasWidth = this._renderService.dimensions.css.canvas.width.toFixed(0);
        const canvasHeight = this._renderService.dimensions.css.canvas.height.toFixed(0);
        this.coreService.triggerDataEvent(`${C0.ESC}[4;${canvasHeight};${canvasWidth}t`);
        break;
      case WindowsOptionsReportType.GET_CELL_SIZE_PIXELS:
        const cellWidth = this._renderService.dimensions.css.cell.width.toFixed(0);
        const cellHeight = this._renderService.dimensions.css.cell.height.toFixed(0);
        this.coreService.triggerDataEvent(`${C0.ESC}[6;${cellHeight};${cellWidth}t`);
        break;
    }
  }

  // TODO: Remove cancel function and cancelEvents option
  public cancel(ev: Event, force?: boolean): boolean | undefined {
    if (!this.options.cancelEvents && !force) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    return false;
  }
}

/**
 * Helpers
 */

function wasModifierKeyOnlyEvent(ev: KeyboardEvent): boolean {
  return ev.keyCode === 16 || // Shift
    ev.keyCode === 17 || // Ctrl
    ev.keyCode === 18; // Alt
}
