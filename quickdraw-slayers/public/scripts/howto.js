// How to Play: a pop-up slideshow (one .howto-step at a time) over a dimmed page.
// Each <section class="howto-step" data-shot="NAME"> looks for an image in public/images/howto/
// called NAME.gif, NAME.png or NAME.jpg. Drop your screenshots/GIFs there (e.g. 02-play-card.gif)
// and they appear automatically; until then a placeholder box is shown.
//
// Two modes:
//   optional (the green ? button): X button, Escape and clicking the dark background all close it.
//   required (new players): no way to skip it. Back/Next only, and Done on the last step.
const HowTo = (function() {
    const EXTENSIONS = ["gif", "png", "jpg"];
    let afterClose = null;          // function to run when the guide is closed (or null)
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
        $(".howto-wrap").scrollTop(0);
    };

    // Open the guide. `callback` runs after it is closed. required = true: it cannot be skipped.
    const open = function(callback, required) {
        afterClose = callback || null;
        isRequired = !!required;
        $("#howto-page").toggleClass("required", isRequired).css("display", "flex");
        $("#help-button").hide();
        showStep(0);
    };

    const close = function() {
        $("#howto-page").hide();
        $("#help-button").show();
        const callback = afterClose;
        afterClose = null;
        if (callback) callback();
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
        $(".howto-back").on("click", () => { if (!isRequired) close(); });

        // Click on the dark background closes the optional guide
        $("#howto-page").on("click", function(e) {
            if (e.target === this && !isRequired) close();
        });

        // Keyboard: arrows move between steps, Escape closes the optional guide
        $(document).on("keydown", function(e) {
            if (!$("#howto-page").is(":visible")) return;
            if (e.key === "ArrowRight") $("#howto-next").click();
            else if (e.key === "ArrowLeft") showStep(current - 1);
            else if (e.key === "Escape" && !isRequired) close();
        });

        // The green ? opens the optional guide from any page
        $("#help-button").on("click", () => open(null, false));
    };

    return { init, open };
})();
