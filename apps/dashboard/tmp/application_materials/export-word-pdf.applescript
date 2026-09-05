on run argv
    set inputPath to item 1 of argv
    set outputPath to item 2 of argv
    tell application "Microsoft Word"
        launch
        set docRef to open inputPath
        save as docRef file name outputPath file format format PDF
        close docRef saving no
    end tell
end run
