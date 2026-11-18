// How to Play: a step-by-step slideshow (one .howto-step at a time).
// Each <section class="howto-step" data-shot="NAME"> looks for an image in public/images/howto/
// called NAME.gif, NAME.png or NAME.jpg. Drop your screenshots/GIFs there (e.g. 02-play-card.gif)
// and they appear automatically; until then a placeholder box is shown.
const HowTo = (function() {
    const EXTENSIONS = ["gif", "png", "jpg"];
    let returnTo = "#game-room-start-page";     // the page to show again when the guide is closed
    let isRequired = false;
    let current = 0;
    let total = 0;

    const loadShot = function($step) {
        const name = $step.data("shot");
        const $box = $("<div class='shot placeholder'>").text(`Screenshot/GIF goes here: images/howto/${name}.gif`);
        $step.append($box);
        const tryNext = (i) => {
            if (i >= EXTENSIONS.length) return;
            const img = new Image();
            img.onload = () => $box.empty().removeClass("placeholder").append(img);
            img.onerror = () => tryNext(i + 1);
            img.src = `images/howto/${name}.${EXTENSIONS[i]}`;
        };
        tryNext(0);
    };

    // Show step number i (0-based) and update the counter, dots and buttons
    const showStep = function(i) {
        current = Math.max(0, Math.min(total - 1, i));
        $(".howto-step").each(function(index) { $(this).toggle(index === current); });
        $("#howto-current").text(current + 1);
        $("#howto-dots .dot").each(function(index) { $(this).toggleClass("active", index === current); });
        $("#howto-prev").prop("disabled", current === 0);
        $("#howto-next").text(current === total - 1 ? "Done" : "Next");
    };

    // Open the guide from page `from`; closing it shows `back` (default: the same page).
    // `back` may also be a function to run when the guide is closed.
    // With required = true (new players) the guide can't be skipped: no Close button, no dots,
    // no Escape. They move with Back/Next and press Done on the last step.
    const open = function(from, back, required) {
        returnTo = back || from;
        isRequired = !!required;
        $("#howto-page").toggleClass("required", isRequired);
        $(from).hide();
        $("#howto-page").show();
        $("#help-button").hide();
        showStep(0);
        window.scrollTo(0, 0);
    };

    const close = function() {
        $("#howto-page").hide();
        $("#help-button").show();
        if (typeof returnTo === "function") returnTo();
        else $(returnTo).show();
    };

    const init = function() {
        const $steps = $(".howto-step");
        total = $steps.length;
        $("#howto-total").text(total);
        $steps.each(function(index) {
            loadShot($(this));
            $("<button type='button' class='dot'>").attr("aria-label", "Step " + (index + 1))
                .on("click", () => showStep(index)).appendTo("#howto-dots");
        });
        showStep(0);

        $("#howto-prev").on("click", () => showStep(current - 1));
        $("#howto-next").on("click", () => { if (current === total - 1) close(); else showStep(current + 1); });
        $(".howto-back").on("click", close);

        // Keyboard: arrows move between steps, Escape closes
        $(document).on("keydown", function(e) {
            if (!$("#howto-page").is(":visible")) return;
            if (e.key === "ArrowRight") $("#howto-next").click();
            else if (e.key === "ArrowLeft") showStep(current - 1);
            else if (e.key === "Escape" && !isRequired) close();
        });

        // The green ? opens the guide from whichever page is showing; closing returns there
        $("#help-button").on("click", function() {
            const pages = ["#game-room-start-page", "#game-room-signin-page", "#game-room-register-page",
                           "#game-room-content-page"];
            const here = pages.find(p => $(p).is(":visible"));
            if (here) open(here);
        });
    };

    return { init, open };
})();
